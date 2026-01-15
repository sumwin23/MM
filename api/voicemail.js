
export const runtime = "nodejs";

import formidable from "formidable";
import fs from "node:fs";
import { put } from "@vercel/blob";
import { Resend } from "resend";

export const config = { api: { bodyParser: false } };

function jerr(res, status, where, err, extra = {}) {
  const detail =
    err?.stack ? String(err.stack) :
    err?.message ? String(err.message) :
    typeof err === "string" ? err :
    JSON.stringify(err);

  // Also log in Vercel logs:
  console.error(`[voicemail] ${where}`, detail, extra);

  return res.status(status).json({
    ok: false,
    where,
    error: detail,
    ...extra
  });
}

function safe(v, n = 3000) { return String(v ?? "").trim().slice(0, n); }

function pickExt(mime) {
  if (!mime) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  return "webm";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    // Prove env vars at runtime (without exposing the values)
    const hasResend = !!process.env.RESEND_API_KEY;
    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

    if (!hasResend || !hasBlob) {
      return res.status(500).json({
        ok: false,
        where: "env-check",
        error: "Missing required env var(s).",
        hasResend,
        hasBlob
      });
    }

    const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024 });

    form.parse(req, async (err, fields, files) => {
      try {
        if (err) return jerr(res, 400, "formidable.parse", err);

        // formidable can return file or array depending on edge cases
        let audio = files?.audio;
        if (Array.isArray(audio)) audio = audio[0];

        if (!audio?.filepath) {
          return jerr(res, 400, "no-audio", "No audio file found in form-data field 'audio'.", {
            fields: Object.keys(fields || {}),
            fileKeys: Object.keys(files || {})
          });
        }

        const name = safe(fields?.name, 120);
        const message = safe(fields?.message, 3000);

        const mime = audio.mimetype || "audio/webm";
        const ext = pickExt(mime);

        let buf;
        try {
          buf = fs.readFileSync(audio.filepath);
        } catch (e) {
          return jerr(res, 500, "read-upload-tempfile", e);
        }

        const filename = `voicemails/voicemail-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

        // 1) Upload to Blob
        let stored;
        try {
          stored = await put(filename, buf, {
            access: "public",
            contentType: mime,
            addRandomSuffix: false
          });
        } catch (e) {
          return jerr(res, 500, "blob.put", e);
        }

        // 2) Email via Resend (don’t fail the whole request if email fails)
        const resend = new Resend(process.env.RESEND_API_KEY);
        const toEmail = process.env.VOICEMAIL_TO || "moremorgellons@gmail.com";
        const fromEmail = process.env.VOICEMAIL_FROM || "onboarding@resend.dev";

        const subject = `New More Morgellons Voicemail${name ? ` from ${name}` : ""}`;

        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif; line-height:1.4;">
            <h2 style="margin:0 0 10px;">New voicemail received 🎙</h2>
            <p style="margin:0 0 8px;"><strong>Name:</strong> ${escapeHtml(name || "(none)")}</p>
            <p style="margin:0 0 8px;"><strong>Message:</strong><br>${escapeHtml(message || "(none)")}</p>
            <p style="margin:12px 0 8px;"><strong>Audio link:</strong><br>
              <a href="${stored.url}">${stored.url}</a>
            </p>
            <p style="margin:0; color:#666; font-size:12px;">File: ${escapeHtml(filename)} • ${escapeHtml(mime)}</p>
          </div>
        `;

        let emailOk = true;
        let emailError = "";
        try {
          await resend.emails.send({ from: fromEmail, to: toEmail, subject, html });
        } catch (e) {
          emailOk = false;
          emailError = String(e?.message || e);
          console.error("[voicemail] resend.send failed:", emailError);
        }

        return res.status(200).json({
          ok: true,
          url: stored.url,
          filename,
          emailOk,
          emailError
        });

      } catch (e) {
        return jerr(res, 500, "parse-callback-top", e);
      }
    });

  } catch (e) {
    return jerr(res, 500, "handler-top", e);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
