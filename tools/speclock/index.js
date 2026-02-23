#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Ajv = require("ajv");

const SPEC_FILE = ".speclock/spec.json";
const SCHEMA_FILE = ".speclock/schema.json";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

function validate() {
  const root = process.cwd();
  const schemaPath = path.join(root, SCHEMA_FILE);
  const specPath = path.join(root, SPEC_FILE);

  if (!fs.existsSync(schemaPath)) { console.error("Missing " + SCHEMA_FILE); process.exit(1); }
  if (!fs.existsSync(specPath)) { console.error("Missing " + SPEC_FILE); process.exit(1); }

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

  const ajv = new Ajv({ allErrors: true, strict: false });
  const fn = ajv.compile(schema);
  const ok = fn(spec);

  if (!ok) {
    console.error("Spec validation failed:");
    for (const e of fn.errors || []) console.error(" - " + (e.instancePath || "/") + " " + (e.message || "invalid"));
    process.exit(1);
  }
  console.log("Spec valid.");
}

function changedFiles(base, head) {
  const out = execSync(`git diff --name-only --merge-base ${base} ${head}`, { encoding: "utf8" });
  return out.split("\n").map(s => s.trim().replace(/\\/g, "/")).filter(Boolean);
}

function drift(base, head) {
  const files = changedFiles(base, head);
  const specChanged = files.includes(SPEC_FILE);

  const hits = [];
  const hit = (desc, pred) => { if (files.some(pred)) hits.push(desc); };

  hit("package.json changed", f => f === "package.json");
  hit("composer deps changed", f => f === "composer.json" || f === "composer.lock");
  hit("database migrations changed", f => f.startsWith("database/migrations/"));
  hit("routes changed", f => f.startsWith("routes/"));
  hit("module migrations changed", f => f.startsWith("Modules/") && f.includes("/Database/Migrations/"));
  hit("module routes changed", f => f.startsWith("Modules/") && f.includes("/Routes/"));

  if (hits.length > 0 && !specChanged) {
    console.error("Drift detected: guarded files changed but .speclock/spec.json was not updated.");
    console.error(`Compared: ${base}..${head}`);
    console.error("Triggered rules:");
    hits.forEach(h => console.error(" - " + h));
    console.error("Changed files:");
    files.forEach(f => console.error(" - " + f));
    process.exit(1);
  }

  if (hits.length === 0) { 
    console.log("No drift rules triggered.");
  } else if (specChanged) {
    console.log("Drift check passed: guarded changes present and spec was updated.");
  } else {
    // unreachable due to earlier exit, but kept for clarity
    console.log("Drift check failed: guarded changes present and spec was not updated.");
  }
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "validate") return validate();
  if (cmd === "drift") {
    const args = parseArgs(rest);
    if (!args.base || !args.head) { console.error("Usage: drift --base <sha> --head <sha>"); process.exit(1); }
    return drift(args.base, args.head);
  }
  console.error("Usage: validate | drift");
  process.exit(1);
}
main();