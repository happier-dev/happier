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

test('promote-website delegates deploy branch promotion to pipeline script', async () => {
  const raw = await loadWorkflow('promote-website.yml');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs promote-deploy-branch/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs deploy/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});
