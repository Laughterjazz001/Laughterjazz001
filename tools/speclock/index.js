#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Ajv = require("ajv");

const SPEC_FILE = ".speclock/spec.json";
const SCHEMA_FILE = ".speclock/schema.json";

// ---- helpers ----
function normalize(p) {
  return String(p || "").trim().replace(/\\/g, "/");
}

function readJson(relPath) {
  const abs = path.join(process.cwd(), relPath);

  if (!fs.existsSync(abs)) {
    console.error(`Missing ${relPath}`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, ""); // strip BOM
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in ${relPath}: ${e.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) out[k] = true;
    else {
      out[k] = v;
      i++;
    }
  }
  return out;
}

// Minimal glob -> RegExp supporting: *, **, ?
function globToRegExp(glob) {
  const g = normalize(glob);
  let re = "^";
  let i = 0;

  while (i < g.length) {
    const c = g[i];

    if (c === "*") {
      // ** or *
      if (g[i + 1] === "*") {
        i += 2;
        // if **/ then match any dirs (including none)
        if (g[i] === "/") {
          i += 1;
          re += "(?:.*\\/)?";
        } else {
          re += ".*";
        }
      } else {
        i += 1;
        re += "[^/]*";
      }
      continue;
    }

    if (c === "?") {
      i += 1;
      re += "[^/]";
      continue;
    }

    // escape regex special chars
    if ("\\.[]{}()+-^$|".includes(c)) {
      re += "\\";
    }
    re += c;
    i += 1;
  }

  re += "$";
  return new RegExp(re);
}

function getChangedFiles(base, head) {
  const cmd = `git diff --name-only --merge-base ${base} ${head}`;
  const out = execSync(cmd, { encoding: "utf8" });
  return out
    .split("\n")
    .map((s) => normalize(s))
    .filter(Boolean);
}

// ---- commands ----
function validate() {
  const schema = readJson(SCHEMA_FILE);
  const spec = readJson(SPEC_FILE);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const fn = ajv.compile(schema);
  const ok = fn(spec);

  if (!ok) {
    console.error("Spec validation failed:");
    for (const e of fn.errors || []) {
      console.error(` - ${(e.instancePath || "/")} ${e.message || "invalid"}`);
    }
    process.exit(1);
  }

  console.log("Spec valid.");
}

function drift(base, head) {
  const files = getChangedFiles(base, head);
  const specChanged = files.includes(normalize(SPEC_FILE));

  // Prefer config from spec.json, but keep safe defaults
  const spec = readJson(SPEC_FILE);
  const configured =
    spec &&
    spec.changePolicy &&
    Array.isArray(spec.changePolicy.requiresSpecUpdateFor)
      ? spec.changePolicy.requiresSpecUpdateFor.map(normalize).filter(Boolean)
      : [];

  const defaults = [
    "package.json",
    "package-lock.json",
    "composer.json",
    "composer.lock",
    "database/migrations/**",
    "routes/**",
    "Modules/**/Database/Migrations/**",
    "Modules/**/Routes/**"
  ];

  const patterns = configured.length ? configured : defaults;
  const compiled = patterns.map((p) => ({ pattern: p, re: globToRegExp(p) }));

  // Collect matches per pattern
  const matched = [];
  for (const c of compiled) {
    const hitFiles = files.filter((f) => c.re.test(f));
    if (hitFiles.length) matched.push({ pattern: c.pattern, files: hitFiles });
  }

  if (matched.length > 0 && !specChanged) {
    console.error("❌ Drift detected.");
    console.error("You changed guarded files but did NOT update .speclock/spec.json.");
    console.error(`Compared (merge-base): ${base}..${head}`);
    console.error("");
    console.error("Triggered rules:");
    for (const m of matched) {
      console.error(` - ${m.pattern}`);
      for (const f of m.files) console.error(`    • ${f}`);
    }
    console.error("");
    console.error("Fix: update .speclock/spec.json to reflect the intent of this change, then commit + push.");
    process.exit(1);
  }

  if (matched.length === 0) {
    console.log("✅ No drift rules triggered.");
    return;
  }

  console.log("✅ Drift check passed: guarded changes present and spec was updated.");
}

function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "validate") return validate();

  if (cmd === "drift") {
    const args = parseArgs(rest);
    if (!args.base || !args.head) {
      console.error("Usage: drift --base <ref> --head <ref>");
      console.error('Example: node tools/speclock/index.js drift --base origin/main --head HEAD');
      process.exit(1);
    }
    return drift(args.base, args.head);
  }

  console.error("Usage: validate | drift");
  process.exit(1);
}

main();
