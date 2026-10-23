#!/usr/bin/env node
// Transcribe a video/audio file with local Whisper (whisper.cpp via
// `hyperframes transcribe`) -> word-level JSON in the kit's transcript format.
// Free and offline after the one-time model download; no API key.
//
// Usage:
//   node scripts/transcribe-local.mjs <input> [options]
//
// Defaults:
//   --output   <input-without-ext>.json next to the source
//   --model    small.en (tiny.en, base.en, small.en, medium.en, large-v3)
//   --language en
//
// Output: { text, language_code, audio_duration_secs, produced_by, words: [{ text, start, end, type }] }
// with times in seconds on the source timeline and duration from ffprobe.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..");

function die(msg, code = 1) {
  console.error(msg);
  exit(code);
}

// --- parse args ---
const args = argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(
    `Usage: node scripts/transcribe-local.mjs <input> [--output path] ` +
      `[--model tiny.en|base.en|small.en|medium.en|large-v3] [--language en]`,
  );
  exit(args.length === 0 ? 1 : 0);
}

const opts = { input: null, output: null, model: "small.en", language: "en" };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--output" || a === "-o") opts.output = args[++i];
  else if (a === "--model" || a === "-m") opts.model = args[++i];
  else if (a === "--language" || a === "--lang") opts.language = args[++i];
  else if (a.startsWith("--")) die(`unknown option: ${a}`);
  else if (!opts.input) opts.input = a;
  else die(`unexpected argument: ${a}`);
}
if (!opts.input) die("no input file given");

const inputPath = resolve(opts.input);
if (!existsSync(inputPath)) die(`input not found: ${inputPath}`);
const inputStem = basename(inputPath, extname(inputPath));
const outputPath = resolve(opts.output ?? join(dirname(inputPath), `${inputStem}.json`));

// --- source duration from ffprobe ---
const probe = spawnSync(
  "ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath],
  { encoding: "utf8" },
);
const duration = Number(probe.stdout?.trim());
if (probe.status !== 0 || !Number.isFinite(duration)) die(`ffprobe failed:\n${probe.stderr ?? ""}`);

// --- run local whisper in a scratch project dir ---
const workDir = mkdtempSync(join(tmpdir(), "transcribe-local-"));
const t0 = Date.now();
const hf = spawnSync(
  "npx",
  ["hyperframes", "transcribe", inputPath, "--dir", workDir, "--engine", "whisper",
    "--model", opts.model, ...(opts.language ? ["--language", opts.language] : [])],
  { cwd: WORKSPACE_ROOT, stdio: ["ignore", "inherit", "inherit"] },
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
const rawPath = join(workDir, "transcript.json");
if (hf.status !== 0 || !existsSync(rawPath)) {
  rmSync(workDir, { recursive: true, force: true });
  die(`hyperframes transcribe failed (exit ${hf.status})`, hf.status || 1);
}

const raw = JSON.parse(readFileSync(rawPath, "utf8"));
rmSync(workDir, { recursive: true, force: true });

// --- normalize to the kit's transcript format ---
const words = (Array.isArray(raw) ? raw : raw.words ?? [])
  .map((w) => ({ text: String(w.text ?? w.word ?? "").trim(), start: Number(w.start), end: Number(w.end), type: "word" }))
  .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
if (words.length === 0) die("no words transcribed", 2);

const json = {
  text: words.map((w) => w.text).join(" "),
  language_code: opts.language || null,
  audio_duration_secs: duration,
  produced_by: `whisper.cpp ${opts.model} (local)`,
  words,
};
writeFileSync(outputPath, JSON.stringify(json, null, 2));
console.log(`ok ${dt}s | ${words.length} words | ${duration.toFixed(1)}s audio | ${outputPath}`);
