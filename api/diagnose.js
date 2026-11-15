// 診断の実行。ブラウザで圧縮済みの動画（3.5MB以下）を受け取り、そのままGeminiに渡します。
// APIキー（GEMINI_API_KEY）とプロンプトはサーバー側だけにあります。
const BASE = "https://generativelanguage.googleapis.com";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash"; // 切り分け用に、環境変数 GEMINI_MODEL で差し替え可能
const MAX_BYTES = 4.2 * 1024 * 1024; // Vercelの本文上限（4.5MB）より少し小さく
const ALLOWED_MIME = ["video/mp4", "video/webm"];

function buildPrompt(memo) {
  return [
    "あなたはプロの教習指導員です。添付された運転動画を見て、「視線の配り方」「車間距離」「ハンドル操作」「速度調整」の4つの観点について、良かった点と改善点を日本語で具体的に出力してください。",
    "出力は次の形式にしてください。観点ごとに見出し（## を付ける）を作り、その下に「良かった点」と「改善点」を箇条書きで書きます。",
    "## 視線の配り方",
    "## 車間距離",
    "## ハンドル操作",
    "## 速度調整",
    "各項目は、動画の中の具体的な場面（わかる場合は時間も添える）を挙げ、どう直せばよいかを一言で書いてください。",
    "動画は容量を小さくするため、画質を下げ、音声を除いています。画質や音声が原因で判断できない観点は、推測せず「動画からは判断できません」と書いてください。交通ルール違反や危険な場面があれば、最初に伝えてください。",
    "回答全体は日本語で800字程度に収めてください。各観点の「良かった点」「改善点」は、それぞれ1〜2個の箇条書きにしてください。",
    memo ? "利用者からの補足：" + memo : ""
  ].filter(Boolean).join("\n");
}

// 本文（動画データ）をストリームから読む。ms 以内に終わらなければ失敗にする
function readBody(req, ms) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const timer = setTimeout(() => reject(new Error("body_timeout")), ms);
    req.on("data", (c) => parts.push(c));
    req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(parts)); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function getBody(req) {
  // Vercelがすでに解析した本文（Buffer）があればそれを使い、なければストリームから読む
  if (Buffer.isBuffer(req.body) && req.body.length) return req.body;
  return readBody(req, 8000);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POSTで呼び出してください。" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "サーバーに GEMINI_API_KEY が設定されていません。" });

  const mime = String(req.headers["x-video-mime"] || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.includes(mime)) return res.status(400).json({ error: "動画の形式（mp4 / webm）が正しくありません。" });

  let memo = "";
  try { memo = decodeURIComponent(String(req.headers["x-memo"] || "")).slice(0, 300); } catch (e) {}

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 52000);

  try {
    // 本文は application/octet-stream の生データ（動画そのもの）として届く
    console.log("diagnose: start, content-length=" + req.headers["content-length"] + ", body is buffer=" + Buffer.isBuffer(req.body));
    const buf = await getBody(req);
    if (!buf.length) return res.status(400).json({ error: "動画データが空です。" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: "動画のサイズが大きすぎます。もう一度圧縮してください。" });

    console.log("diagnose: received " + buf.length + " bytes, mime=" + mime + ", model=" + MODEL + ", " + (Date.now() - t0) + "ms");
    const r = await fetch(BASE + "/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: mime, data: buf.toString("base64") } },
            { text: buildPrompt(memo) }
          ]
        }],
        // 無料プランの関数は最長60秒のため、思考を軽め（low）にして時間内に返します
        generationConfig: { maxOutputTokens: 3000, thinkingConfig: { thinkingLevel: "low" } }
      })
    });
    const data = await r.json().catch(() => ({}));
    console.log("diagnose: gemini status " + r.status + ", total " + (Date.now() - t0) + "ms");
    if (!r.ok) return res.status(502).json({ error: "診断に失敗しました（" + r.status + "）：" + (data.error?.message || "") });

    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      return res.status(502).json({ error: data.promptFeedback?.blockReason ? "内容の安全性判定により結果が返されませんでした。" : "AIから結果が返ってきませんでした。" });
    }
    return res.status(200).json({ text });
  } catch (e) {
    console.log("diagnose: error " + (e && e.name) + " after " + (Date.now() - t0) + "ms");
    if (e && e.message === "body_timeout") {
      return res.status(408).json({ error: "動画データを受信できませんでした。もう一度お試しください。" });
    }
    if (e && e.name === "AbortError") {
      return res.status(504).json({ error: "AIの応答が時間内に返りませんでした。もっと短い動画で、もう一度お試しください。" });
    }
    return res.status(500).json({ error: "サーバーでエラーが発生しました。" });
  } finally {
    clearTimeout(timer);
  }
};
