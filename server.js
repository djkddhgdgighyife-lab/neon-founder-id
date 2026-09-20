import cors from "cors";
import express from "express";
import { existsSync, readFileSync } from "fs";
import fs from "fs/promises";
import multer from "multer";
import path from "path";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 8787;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const outputDir = path.join(__dirname, "public", "results");
const templateDir = path.join(__dirname, "public", "templates");
const kieInputDir = path.join(__dirname, "private", "kie-inputs");
const distDir = path.join(__dirname, "dist");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const delimiter = entry.indexOf("=");
    if (delimiter < 0) continue;
    const key = entry.slice(0, delimiter).trim();
    const value = entry.slice(delimiter + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadLocalEnv();

// Single provider for the kiosk: Kie.ai's cloud image editor.
const kieApiKey = process.env.KIE_API_KEY?.trim();
const kieImageModel = process.env.KIE_IMAGE_MODEL?.trim() || "nano-banana-pro";
const kieBaseUrl = (process.env.KIE_BASE_URL?.trim() || "https://api.kie.ai").replace(/\/$/, "");
const kieUploadBaseUrl = (process.env.KIE_UPLOAD_BASE_URL?.trim() || "https://kieai.redpandaai.co").replace(/\/$/, "");
const resultWidth = 720;
const resultHeight = 960;
const templateConfigs = {
  students: {
    architect: { file: "architect.png", head: { x: 1790, y: 1250, width: 980, height: 1450 } },
    innovator: { file: "innovator.png", head: { x: 1710, y: 1030, width: 1070, height: 1510 } },
    owner: { file: "owner.png", head: { x: 1795, y: 1240, width: 960, height: 1420 } },
    hybrid: { file: "hybrid.jpg", head: { x: 1790, y: 1240, width: 1000, height: 1470 } },
  },
  pros: {
    architect: { file: "pro-architect.png", head: { x: 1710, y: 760, width: 1010, height: 1630 } },
    innovator: { file: "pro-innovator.png", head: { x: 1700, y: 900, width: 1040, height: 1580 } },
    owner: { file: "pro-owner.png", head: { x: 1740, y: 980, width: 970, height: 1510 } },
    hybrid: { file: "pro-hybrid.png", head: { x: 1740, y: 750, width: 1000, height: 1640 } },
  },
};

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(templateDir, { recursive: true });
await fs.mkdir(kieInputDir, { recursive: true });
app.use(cors());
app.use(express.json());
app.use("/results", express.static(outputDir));
app.use("/templates", express.static(templateDir));
app.use("/kie-inputs", express.static(kieInputDir, { index: false, fallthrough: false }));
if (existsSync(distDir)) app.use(express.static(distDir));

async function uploadKieInput(buffer, extension) {
  if (!kieApiKey) throw new Error("KIE_API_KEY is not configured");
  const filename = `${randomUUID()}.${extension}`;
  const response = await fetch(`${kieUploadBaseUrl}/api/file-base64-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${kieApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      base64Data: `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${buffer.toString("base64")}`,
      uploadPath: "neon-founder-id",
      fileName: filename,
    }),
  });
  if (!response.ok) throw new Error(`Kie.ai input upload failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json();
  const url = payload?.data?.fileUrl || payload?.data?.downloadUrl;
  if (!url) throw new Error(`Kie.ai input upload returned no file URL: ${JSON.stringify(payload).slice(0, 400)}`);
  return url;
}

async function waitForKieTask(taskId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${kieBaseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${kieApiKey}` },
    });
    if (!response.ok) throw new Error(`Kie.ai task status failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
    const payload = await response.json();
    const state = String(payload?.data?.state || payload?.data?.status || "").toLowerCase();
    console.log(`Kie.ai task ${taskId}: ${state || "unknown"} (${payload?.data?.progress ?? 0}%)`);
    const result = payload?.data?.resultJson
      ? (typeof payload.data.resultJson === "string" ? JSON.parse(payload.data.resultJson) : payload.data.resultJson)
      : payload?.data?.result || payload?.data;
    const imageUrl = result?.resultUrls?.[0] || result?.imageUrls?.[0] || result?.images?.[0] || result?.output?.[0];
    if (imageUrl) return imageUrl;
    if (["fail", "failed", "error"].includes(state)) throw new Error(`Kie.ai generation failed: ${payload?.data?.failMsg || payload?.data?.errorMessage || "unknown error"}`);
  }
  throw new Error("Kie.ai generation timed out after 2 minutes");
}

async function createKiePoster(photoBuffer, profile) {
  if (!kieApiKey) throw new Error("KIE_API_KEY is not configured");
  const templates = templateConfigs[profile.audience === "pros" ? "pros" : "students"];
  const config = templates[profile.id] ?? templates.hybrid;
  const templatePath = path.join(templateDir, config.file);
  if (!existsSync(templatePath)) throw new Error(`Template is missing: ${config.file}`);
  const template = await sharp(templatePath).png().toBuffer();
  const portrait = await sharp(photoBuffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 94 }).toBuffer();
  const { x, y, width, height } = config.head;
  const prompt = [
    "Create a single photorealistic, print-ready career poster using Image 1 as the locked composition and Image 2 only as the identity reference for the participant.",
    `At x=${x}, y=${y}, width=${width}, height=${height}, replace the empty black head area with a complete, naturally integrated human head and neck of the person in Image 2.`,
    "The person must look like they were photographed in this scene: correct head size and three-quarter pose, natural hair silhouette, ears, jawline, neck, hoodie collar occlusion, realistic skin texture, warm side lighting, matching shadows, lens perspective, colour grade and depth of field.",
    "No cutout, no oval crop, no pasted portrait, no hard edge, no visible mask, no floating head, no duplicated face, no exposed background from the source photo.",
    "Preserve the poster canvas, camera framing, body pose, hands, background, logo, QR code, Russian typography and all existing text exactly. Do not add or alter text, logos, watermarks, objects or people. Return only the finished 3:4 poster.",
  ].join(" ");
  const [templateUrl, portraitUrl] = await Promise.all([uploadKieInput(template, "png"), uploadKieInput(portrait, "jpg")]);
  const response = await fetch(`${kieBaseUrl}/api/v1/jobs/createTask`, {
    method: "POST", headers: { Authorization: `Bearer ${kieApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: kieImageModel,
      input: { prompt, image_input: [templateUrl, portraitUrl], aspect_ratio: "3:4", resolution: "1K", output_format: "png" },
    }),
  });
  if (!response.ok) throw new Error(`Kie.ai image edit failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const created = await response.json();
  const taskId = created?.data?.taskId || created?.taskId;
  if (!taskId) throw new Error(`Kie.ai returned no task id: ${JSON.stringify(created).slice(0, 400)}`);
  console.log(`Kie.ai task created: ${taskId}`);
  const imageUrl = await waitForKieTask(taskId);
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error("Kie.ai result image could not be downloaded");
  return sharp(Buffer.from(await imageResponse.arrayBuffer()))
    .resize(resultWidth, resultHeight, { fit: "fill" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// Local preview is available only when the single configured model cannot be reached.
async function createPreviewComposite(photoBuffer, profile) {
  const templates = templateConfigs[profile.audience === "pros" ? "pros" : "students"];
  const config = templates[profile.id] ?? templates.hybrid;
  const templatePath = path.join(templateDir, config.file);
  const { x, y, width, height } = config.head;
  const portrait = await sharp(photoBuffer).rotate().resize(width, height, { fit: "cover", position: "top" }).modulate({ brightness: 0.99, saturation: 1.04, hue: 2 }).sharpen({ sigma: 0.7 }).png().toBuffer();
  const mask = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><filter id="b"><feGaussianBlur stdDeviation="14"/></filter></defs><ellipse filter="url(#b)" fill="white" cx="${width / 2}" cy="${height * 0.37}" rx="${width * 0.4}" ry="${height * 0.36}"/><path filter="url(#b)" fill="white" d="M ${width * 0.28} ${height * 0.52} C ${width * 0.35} ${height * 0.76},${width * 0.65} ${height * 0.76},${width * 0.72} ${height * 0.52} L ${width * 0.88} ${height} L ${width * 0.12} ${height} Z"/></svg>`);
  const masked = await sharp(portrait).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return sharp(templatePath)
    .composite([{ input: masked, left: x, top: y - Math.round(height * 0.12) }])
    .resize(resultWidth, resultHeight, { fit: "fill" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

app.post("/api/process-photo", upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).send("Photo is required");
  try {
    const profile = { id: String(req.body.profile || "hybrid"), audience: String(req.body.audience || "students") };
    const result = await createKiePoster(req.file.buffer, profile);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await fs.writeFile(path.join(outputDir, filename), result);
    res.json({ resultUrl: `/results/${filename}`, aiUsed: true, aiProvider: "kie" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kie.ai processing failed";
    console.error(message);
    try {
      const profile = { id: String(req.body.profile || "hybrid"), audience: String(req.body.audience || "students") };
      const preview = await createPreviewComposite(req.file.buffer, profile);
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      await fs.writeFile(path.join(outputDir, filename), preview);
      res.json({
        resultUrl: `/results/${filename}`,
        aiUsed: false,
        aiProvider: "local-preview",
        warning: "Нейросеть недоступна, поэтому использована локальная обработка фото.",
      });
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Local photo processing failed";
      console.error(fallbackMessage);
      res.status(502).json({
        error: "Не удалось обработать фото. Попробуйте ещё раз.",
        detail: fallbackMessage.replace(/Bearer\s+\S+|key=[^&\s]+/gi, "[redacted]"),
      });
    }
  }
});

if (existsSync(distDir)) {
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/results/") || req.path.startsWith("/templates/")) {
      return next();
    }
    return res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(port, () => console.log(`Photo processor listening on http://localhost:${port}`));
