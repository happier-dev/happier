#!/usr/bin/env node
// Advisory plan lint for the happier-plan gate (adopted from INSTR-V3 R6b).
// No CI gate. PR-10 reconciles R6b's lexical proposal: check structure, not wording.
// Usage: node scripts/plans/lintPlan.mjs <plan.md>...   Exit 1 on findings. Never checks size.
// Rules: gate headings present; each ledger row names an owner and a harm, and a reference
// or a Happier-specific requirement. Security prose, evidence and tracking remain valid.
import { readFileSync } from 'node:fs';

const GATE = ['## Gate', '### 1. Flows', '### 2. Mechanism ledger', '### 3. Accepted imperfections', '### 4. Ship journey'];

function lint(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  const at = (i, msg) => out.push(`${path}:${i + 1}: ${msg}`);
  const headings = new Set();

  let section = '', inFence = false, ledgerHeader = null;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    if (/^#{2,3} /.test(line)) { section = line.trim(); headings.add(section); ledgerHeader = null; }
    const inLedger = section === '### 2. Mechanism ledger';
    const isRow = /^\s*\|/.test(line) && !/^\s*\|[\s|:-]+\|\s*$/.test(line);

    if (inLedger && isRow) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!ledgerHeader) { ledgerHeader = cells.map((c) => c.toLowerCase()); return; }
      const col = (word) => ledgerHeader.findIndex((h) => h.includes(word));
      const owner = cells[col('owner')], harm = cells[col('harm')], ref = cells[col('reference')];
      if (!owner) at(i, 'ledger row without an owner');
      if (!harm) at(i, 'ledger row without a user-visible harm');
      if (!ref) at(i, 'ledger row without a reference or a Happier-specific requirement');
    }
  });
  for (const h of GATE) if (!headings.has(h)) out.push(`${path}: missing gate heading "${h}"`);
  return out;
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: lintPlan.mjs <plan.md>...'); process.exit(2); }
const findings = files.flatMap(lint);
for (const f of findings) console.log(f);
console.log(`${findings.length} finding(s) in ${files.length} plan(s)`);
process.exit(findings.length ? 1 : 0);
