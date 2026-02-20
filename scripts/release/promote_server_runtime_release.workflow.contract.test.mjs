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

test('promote-server delegates GitHub release publishing to pipeline script', async () => {
  const raw = await loadWorkflow('promote-server.yml');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs github-publish-release/);
  assert.doesNotMatch(raw, /gh release upload/, 'promote-server should not embed gh release upload');
  assert.doesNotMatch(raw, /gh release create/, 'promote-server should not embed gh release create');
});
