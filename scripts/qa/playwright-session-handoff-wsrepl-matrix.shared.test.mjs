import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('playwright session handoff wsrepl matrix helper resolves the repo root from scripts/qa', async () => {
  const mod = await import('./playwright-session-handoff-wsrepl-matrix.shared.mjs');

  assert.equal(
    mod.resolveRepoRoot(),
    resolve(join(__dirname, '..', '..')),
  );
});
