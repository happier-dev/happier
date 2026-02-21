import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-actor-guard action supports trusted actors and URL-encodes actor paths', async () => {
  const actionPath = resolve(repoRoot, '.github', 'actions', 'release-actor-guard', 'action.yml');
  const raw = fs.readFileSync(actionPath, 'utf8');

  assert.match(raw, /\n\s*trusted_actors:\n/, 'action.yml must define a trusted_actors input');
  assert.match(raw, /INPUT_TRUSTED_ACTORS/, 'action should pass trusted_actors into the verify step env');
  assert.match(raw, /\|@uri/, 'action should URL-encode actor when building GitHub API URLs');
});

test('deploy workflows trust the release bot actor for push-triggered deployments', async () => {
  const deployOnPath = resolve(repoRoot, '.github', 'workflows', 'deploy-on-deploy-branch.yml');
  const deployPath = resolve(repoRoot, '.github', 'workflows', 'deploy.yml');

  const deployOnRaw = fs.readFileSync(deployOnPath, 'utf8');
  const deployRaw = fs.readFileSync(deployPath, 'utf8');

  assert.match(
    deployOnRaw,
    /trusted_actors:\s*happier-release-bot\[bot\]/,
    'deploy-on-deploy-branch should trust the release bot actor so deploy-branch pushes can deploy',
  );
  assert.match(
    deployRaw,
    /trusted_actors:\s*happier-release-bot\[bot\]/,
    'deploy workflow should trust the release bot actor so workflow_call can deploy',
  );
});
