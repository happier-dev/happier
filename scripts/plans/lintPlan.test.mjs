import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const lint = fileURLToPath(new URL('./lintPlan.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}.md`, import.meta.url));

test('accepts the proposed gate with owner-bound authority and security wording', () => {
  const result = spawnSync(process.execPath, [lint, fixture('good')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /0 finding\(s\)/);
});

test('accepts owner-bound fail-closed security prose, quoted evidence and designated tracking', () => {
  const result = spawnSync(process.execPath, [lint, fixture('security')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /0 finding\(s\)/);
});

test('reports missing owner, harm and requirement', () => {
  const result = spawnSync(process.execPath, [lint, fixture('bad')], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  for (const diagnostic of [
    'ledger row without an owner',
    'ledger row without a user-visible harm',
    'ledger row without a reference or a Happier-specific requirement',
  ]) assert.ok(result.stdout.includes(diagnostic), diagnostic);
});

test('quoted headings do not satisfy the required plan gate', () => {
  const result = spawnSync(process.execPath, [lint, fixture('quoted-gate')], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /missing gate heading "## Gate"/);
});
