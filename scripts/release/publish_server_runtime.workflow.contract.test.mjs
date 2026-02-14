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

test('publish-server-runtime workflow exists and does not manage deploy branches', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');

  assert.match(raw, /name:\s*PUBLISH\s+—\s+Server Runtime/i);
  assert.match(raw, /workflow_dispatch:/);
  assert.match(raw, /workflow_call:/);

  assert.doesNotMatch(raw, /deploy\//, 'server runtime publish must not push deploy/* branches');
  assert.doesNotMatch(raw, /Promote source ref to deploy branch/i);
});

test('publish-server-runtime workflow publishes rolling server-preview tag via release bot', async () => {
  const raw = await loadWorkflow('publish-server-runtime.yml');

  assert.match(raw, /actions\/create-github-app-token@v1/);
  assert.match(raw, /RELEASE_BOT_APP_ID/);
  assert.match(raw, /RELEASE_BOT_PRIVATE_KEY/);

  assert.match(raw, /server-preview/);
  assert.match(raw, /rolling_tag/);
  assert.match(raw, /uses:\s*\.\/\.github\/workflows\/publish-github-release\.yml/);
});
