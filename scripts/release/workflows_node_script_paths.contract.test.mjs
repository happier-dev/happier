import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

/**
 * @param {string} p
 */
function normalizePath(p) {
  return p.replaceAll('\\\\', '/');
}

test('workflows only reference existing node script entrypoints', () => {
  const files = fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yml'))
    .map((e) => path.join(workflowsDir, e.name));

  /** @type {{ workflow: string; script: string }[]} */
  const missing = [];

  for (const workflowPath of files) {
    const raw = fs.readFileSync(workflowPath, 'utf8');
    const workflowName = path.relative(repoRoot, workflowPath) || workflowPath;

    const re = /\bnode\s+([./A-Za-z0-9_-]+\.mjs)\b/g;
    for (const match of raw.matchAll(re)) {
      const scriptRel = String(match[1] ?? '').trim();
      if (!scriptRel) continue;
      if (path.isAbsolute(scriptRel)) continue;

      const abs = path.join(repoRoot, scriptRel);
      if (!fs.existsSync(abs)) {
        missing.push({ workflow: normalizePath(workflowName), script: normalizePath(scriptRel) });
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    missing.length > 0
      ? `Missing node script(s) referenced by workflows:\n${missing.map((m) => `- ${m.workflow}: ${m.script}`).join('\n')}`
      : 'expected no missing node script references',
  );
});

