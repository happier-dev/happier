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

test('publish-github-release updates rolling releases with commit summaries and a compare link', async () => {
  const { raw } = await loadWorkflow('publish-github-release.yml');

  assert.match(raw, /old_sha=/, 'rolling tag move should capture previous tag SHA for notes');
  assert.match(raw, /rev-list --count/, 'rolling release notes should count commits between old and new tag targets');
  assert.match(raw, /git log/, 'rolling release notes should include a commit list');
  assert.match(raw, /compare\/\$\{OLD_SHA\}\.\.\.\$\{SHA\}/, 'rolling release notes should include a GitHub compare link');
  assert.match(raw, /gh release edit/, 'rolling release notes should edit the existing release');
  assert.match(raw, /release_message:/, 'publish-github-release should accept a release_message input');
  assert.match(raw, /RELEASE_MESSAGE:/, 'publish-github-release should thread release_message into the publish job env');
  assert.match(raw, /\$\{\s*RELEASE_MESSAGE\s*\}/, 'rolling release notes should include the release message when provided');
});
