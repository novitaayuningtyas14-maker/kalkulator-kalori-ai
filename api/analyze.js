import OpenAI from "openai";

const aiModel = "gpt-4o-mini";

function computeBMR(user) {
  const w = Number(user.berat || 0);
  const h = Number(user.tinggi || 0);
  const a = Number(user.umur || 0);
  const s = (user.jenisKelamin || "L");
  if (s === "L") {
    return 10 * w + 6.25 * h - 5 * a + 5;
  } else {
    return 10 * w + 6.25 * h - 5 * a - 161;
  }
}

function sessionRangePercent(jenisMakan) {
  switch ((jenisMakan || "").toLowerCase()) {
    case "sarapan": return [0.25, 0.30];
    case "makan siang": return [0.30, 0.35];
    case "makan malam": return [0.25, 0.30];
    case "snack": return [0.05, 0.10];
    default: return [0.25, 0.30];
  }
}

async function callOpenAI(prompt, openai) {
  const resp = await openai.chat.completions.create({
    model: aiModel,
    messages: [{ role: "system", content: "Kamu adalah asisten ahli nutrisi yang menjawab dalam JSON terstruktur." }, { role: "user", content: prompt }],
    max_tokens: 750,
    temperature: 0.2
  });
  return resp.choices?.[0]?.message?.content ?? "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const body = req.body || {};
  const required = ["nama", "umur", "berat", "tinggi", "jenisKelamin", "aktivitas", "jenisMakan", "karbo", "protein", "lemak", "makanan"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return res.status(400).json({ ok: false, error: `Missing field: ${k}` });
    }
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
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

    const [pMin, pMax] = sessionRangePercent(food.jenisMakan);
    const targetMin = Math.round(tdee * pMin);
    const targetMax = Math.round(tdee * pMax);
    const targetMedian = Math.round((targetMin + targetMax) / 2);
    const deltaPercent = Math.round(((kaloriMakanan - targetMedian) / targetMedian) * 100);

    let baselineStatus = "Sesuai";
    if (deltaPercent < -15) baselineStatus = "Kekurangan";
    else if (deltaPercent > 15) baselineStatus = "Kelebihan";

    const prompt = `
Berikan jawaban dalam JSON valid. Jangan sertakan teks lain.
Input:
User: ${JSON.stringify(user)}
Food: ${JSON.stringify(food)}
Perhitungan lokal: kaloriMakanan=${kaloriMakanan}, BMR=${Math.round(bmr)}, TDEE=${tdee}, targetMin=${targetMin}, targetMax=${targetMax}, targetMedian=${targetMedian}, deltaPercent=${deltaPercent}, statusBaseline=${baselineStatus}

Tugas:
1) Konfirmasi kembali angka-angka: kaloriMakanan, tdee, targetMin, targetMax, targetMedian, deltaPercent
2) Berikan evaluasi: Kekurangan|Sesuai|Kelebihan (berdasarkan deltaPercent)
3) Berikan penjelasan singkat (1-2 kalimat) kenapa
4) Berikan rekomendasi tindakan: (a) rekomendasi porsi/jenis makanan selanjutnya yang spesifik (mis. \"Tambah 1 porsi nasi + 100g dada ayam\") (b) tiga contoh menu lokal Indonesia yang memenuhi kebutuhan tambahan bila Kekurangan
5) Output harus berupa JSON dengan properti:
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
Pastikan JSON valid dan tidak ada teks tambahan di luar JSON.
`;

    const aiText = await callOpenAI(prompt, openai);

    let aiJson;
    try {
      aiJson = JSON.parse(aiText);
    } catch (e) {
      aiJson = {
        kaloriMakanan,
        bmr: Math.round(bmr),
        tdee,
        targetMin,
        targetMax,
        targetMedian,
        deltaPercent,
        evaluasi: baselineStatus,
        penjelasan: "AI gagal mengembalikan JSON yang valid; gunakan nilai perhitungan dasar.",
        rekomendasi: baselineStatus === "Kekurangan" ? "Tambahkan porsi berenergi; misal nasi + protein." : baselineStatus === "Kelebihan" ? "Kurangi porsi dan pilih protein rendah lemak." : "Pertahankan pola makan seimbang.",
        contohMenu: baselineStatus === "Kekurangan" ? ["Nasi + ayam panggang + sayur", "Oatmeal + telur", "Smoothie pisang + yoghurt + kacang"] : ["Sayur kukus + ikan panggang", "Salad + dada ayam", "Sop tanpa nasi"]
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

    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(out));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
