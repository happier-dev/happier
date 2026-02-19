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

  assert.match(raw, /actions\/create-github-app-token@v1/, 'publish-github-release must use actions/create-github-app-token@v1');
  assert.match(raw, /node scripts\/pipeline\/github\/publish-release\.mjs/, 'publish-github-release must delegate to pipeline script');
  assert.match(
    raw,
    /persist-credentials:\s*false/,
    'publish-github-release must not persist GITHUB_TOKEN git credentials when using the release bot token',
  );
  assert.match(
    raw,
    /unset-all http\.https:\/\/github\.com\/\.extraheader/,
    'publish-github-release must clear checkout-provided auth headers before tag pushes',
  );
});

test('publish-github-release passes release note inputs through to the pipeline script', async () => {
  const { raw } = await loadWorkflow('publish-github-release.yml');

  assert.match(raw, /release_message:/, 'publish-github-release should accept a release_message input');
  assert.match(raw, /release_message:\s*\$\{\{\s*inputs\.release_message\s*\}\}/, 'workflow should pass release_message input');
});
