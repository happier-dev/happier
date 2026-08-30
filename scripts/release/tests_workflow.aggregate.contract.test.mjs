import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function jobIds(raw) {
  const jobs = raw.slice(raw.indexOf('\njobs:'));
  return [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]).filter((id) => id !== 'ci_summary');
}

test('tests workflow summary covers every top-level CI lane', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const summary = raw.match(/\n  ci_summary:[\s\S]*?\n  [A-Za-z0-9_-]+:/)?.[0] ?? raw.slice(raw.indexOf('\n  ci_summary:'));
  const needs = summary.match(/needs: \[([^\]]+)\]/)?.[1]?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
  assert.ok(needs.length > 0, 'ci_summary must declare its lane dependencies');
  assert.deepEqual(new Set(needs), new Set(jobIds(raw)), 'ci_summary.needs must stay synchronized with every top-level CI lane');
  assert.match(raw, /result !== 'success' && result !== 'skipped'/, 'collector must fail closed for every non-success lane result');
  assert.doesNotMatch(raw, /\["failure","cancelled"\]\.includes\(v\.result\)/, 'collector must not ignore timeout/startup/stale conclusions');
  assert.match(raw, /ci-summary\.json/, 'collector must write a machine-readable summary artifact');
  assert.match(raw, /name: Upload machine-readable CI summary[\s\S]*?if: always\(\)/, 'summary artifact must upload even when a lane fails');
});
