import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

test('publish-github-release uses release bot GitHub App token for rolling tag updates', async () => {
  const { raw, parsed } = await loadWorkflow('publish-github-release.yml');
  const publishJob = parsed?.jobs?.publish;
  assert.ok(publishJob, 'publish job should exist');
  assert.equal(
    publishJob?.env?.RELEASE_BOT_APP_ID,
    '${{ secrets.RELEASE_BOT_APP_ID }}',
    'publish job must expose RELEASE_BOT_APP_ID via env for conditional app token creation',
  );
  assert.equal(
    publishJob?.env?.RELEASE_BOT_PRIVATE_KEY,
    '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}',
    'publish job must expose RELEASE_BOT_PRIVATE_KEY via env for conditional app token creation',
  );

  assert.match(raw, /Create GitHub App token \(release bot\)/, 'publish-github-release must mint release-bot token');
  assert.match(raw, /actions\/create-github-app-token@v1/, 'publish-github-release must use actions/create-github-app-token@v1');
  assert.match(raw, /Move rolling tag/, 'publish-github-release must include a rolling tag move step');
});

