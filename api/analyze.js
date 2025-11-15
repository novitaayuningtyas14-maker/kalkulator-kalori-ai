import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

function computeBMR(user){
  const w = Number(user.berat || 0);
  const h = Number(user.tinggi || 0);
  const a = Number(user.umur || 0);
  const s = (user.jenisKelamin || "L");
  if(s === "L") return 10*w + 6.25*h - 5*a + 5;
  return 10*w + 6.25*h - 5*a - 161;
}

function sessionRange(jenisMakan){
  const k = (jenisMakan || "").toLowerCase();
  if(k.includes("sarapan")) return [0.25,0.30];
  if(k.includes("siang")) return [0.30,0.35];
  if(k.includes("malam")) return [0.25,0.30];
  if(k.includes("snack")) return [0.05,0.10];
  return [0.25,0.30];
}

async function callAI(prompt, openai){
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: "Kamu adalah asisten ahli nutrisi. Balas dalam JSON yang valid." }, { role:"user", content: prompt }],
    max_tokens: 700,
    temperature: 0.2
  });
  return resp.choices?.[0]?.message?.content ?? "";
}

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  try{
    const body = req.body || {};
    const required = ["nama","umur","berat","tinggi","jenisKelamin","aktivitas","jenisMakan","karbo","protein","lemak","makanan"];
    for(const k of required){ if(body[k] === undefined || body[k] === null || body[k] === "") return res.status(400).json({ ok:false, error:`Missing field: ${k}` }); }

    const user = {
      nama: String(body.nama || ""),
      umur: Number(body.umur || 0),
      berat: Number(body.berat || 0),
      tinggi: Number(body.tinggi || 0),
      jenisKelamin: String(body.jenisKelamin || "L"),
      aktivitas: String(body.aktivitas || "1.55")
    };

    const food = {
      jenisMakan: String(body.jenisMakan || ""),
      makanan: String(body.makanan || ""),
      karbo: Number(body.karbo || 0),
      protein: Number(body.protein || 0),
      lemak: Number(body.lemak || 0)
    };

    const bmr = computeBMR(user);
    const aktivitasFactor = Number(user.aktivitas) || 1.55;
    const tdee = Math.round(bmr * aktivitasFactor);
    const kaloriMakanan = Math.round(food.karbo * 4 + food.protein * 4 + food.lemak * 9);

    const [pMin, pMax] = sessionRange(food.jenisMakan);
    const targetMin = Math.round(tdee * pMin);
    const targetMax = Math.round(tdee * pMax);
    const targetMedian = Math.round((targetMin + targetMax) / 2);
    const deltaPercent = Math.round(((kaloriMakanan - targetMedian) / (targetMedian || 1)) * 100);

    let baseline = "Sesuai";
    if(deltaPercent < -15) baseline = "Kekurangan";
    else if(deltaPercent > 15) baseline = "Kelebihan";

    const prompt = `
User: ${JSON.stringify(user)}
Food: ${JSON.stringify(food)}
Perhitungan lokal: kaloriMakanan=${kaloriMakanan}, bmr=${Math.round(bmr)}, tdee=${tdee}, targetMin=${targetMin}, targetMax=${targetMax}, targetMedian=${targetMedian}, deltaPercent=${deltaPercent}, baseline=${baseline}

Tugas:
Buat JSON valid (tanpa teks lain) dengan properti:
{
  "kaloriMakanan": number,
  "bmr": number,
  "tdee": number,
  "targetMin": number,
  "targetMax": number,
  "targetMedian": number,
  "deltaPercent": number,
  "evaluasi": "Kekurangan"|"Sesuai"|"Kelebihan",
  "penjelasan": "string",
  "rekomendasi": "string",
  "contohMenu": ["string","string","string"]
}
Gunakan baseline sebagai referensi, tambahkan rekomendasi spesifik (mis. \"Tambah 1 porsi nasi ~100g + dada ayam 100g\"). Jawab hanya JSON.
`;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const aiText = await callAI(prompt, openai);

    let aiJson;
    try{
      aiJson = JSON.parse(aiText);
    }catch(e){
      aiJson = {
        kaloriMakanan,
        bmr: Math.round(bmr),
        tdee,
        targetMin,
        targetMax,
        targetMedian,
        deltaPercent,
        evaluasi: baseline,
        penjelasan: baseline === "Kekurangan" ? "Asupan di bawah target sesi." : baseline === "Kelebihan" ? "Asupan di atas target sesi." : "Asupan mendekati target.",
        rekomendasi: baseline === "Kekurangan" ? "Tambah nasi + protein (mis. nasi 100g + ayam 100g)" : baseline === "Kelebihan" ? "Kurangi porsi atau pilih makanan rendah lemak." : "Pertahankan pola makan seimbang.",
        contohMenu: baseline === "Kekurangan" ? ["Nasi + ayam panggang + sayur", "Oatmeal + telur", "Smoothie pisang + yoghurt"] : ["Salad + ikan panggang", "Sayur kukus + tahu", "Sup sayur"]
      };
    }

    const out = {
      ok: true,
      result: {
        ...aiJson,
        kaloriMakanan,
        bmr: Math.round(bmr),
        tdee,
        targetMin,
        targetMax,
        targetMedian,
        deltaPercent
      }
    };

    res.setHeader("Content-Type","application/json");
    res.status(200).send(JSON.stringify(out));
  }catch(err){
    res.status(500).json({ ok:false, error: String(err) });
  }
}
