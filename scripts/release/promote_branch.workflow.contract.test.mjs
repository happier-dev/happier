import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-branch delegates branch updates to pipeline script', async () => {
  const raw = await loadWorkflow('promote-branch.yml');
  assert.match(raw, /actions\/create-github-app-token@v1/);
  assert.match(raw, /node scripts\/pipeline\/github\/promote-branch\.mjs/);
});

