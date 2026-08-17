import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-actor-guard action supports trusted actors and URL-encodes actor paths', async () => {
  const actionPath = resolve(repoRoot, '.github', 'actions', 'release-actor-guard', 'action.yml');
  const raw = fs.readFileSync(actionPath, 'utf8');
  const action = YAML.parse(raw);

  assert.match(raw, /\n\s*trusted_actors:\n/, 'action.yml must define a trusted_actors input');
  assert.match(raw, /INPUT_TRUSTED_ACTORS/, 'action should pass trusted_actors into the verify step env');
  assert.match(raw, /\|@uri/, 'action should URL-encode actor when building GitHub API URLs');
  const token = action.runs.steps.find(
    (step) => String(step.uses ?? '').startsWith('actions/create-github-app-token@'),
  );
  assert.equal(
    token.uses,
    'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547',
  );
  assert.equal(token.with.owner, '${{ steps.params.outputs.org }}');
  assert.equal(token.with.repositories, '${{ github.event.repository.name }}');
  assert.equal(token.with['permission-members'], 'read');
  assert.match(token.if, /trusted_actor/);
});

test('release-actor-guard retries transient GitHub API failures at its shared HTTP boundary', () => {
  const actionPath = resolve(repoRoot, '.github', 'actions', 'release-actor-guard', 'action.yml');
  const raw = fs.readFileSync(actionPath, 'utf8');

  assert.match(raw, /github_api_status\(\)/, 'the action should own GitHub API retry policy in one helper');
  assert.match(raw, /--retry 3/);
  assert.match(raw, /--retry-delay 1/);
  assert.match(raw, /--retry-max-time 90/);
  assert.match(raw, /--retry-all-errors/);
  assert.equal((raw.match(/\bcurl /g) ?? []).length, 1, 'all guard API reads should use the shared retrying helper');
});

test('release-actor-guard fails over from exhausted collaborator REST failures to exact GraphQL admin evidence', () => {
  const actionPath = resolve(repoRoot, '.github', 'actions', 'release-actor-guard', 'action.yml');
  const raw = fs.readFileSync(actionPath, 'utf8');

  assert.match(raw, /429\|5\?\?/);
  assert.match(raw, /https:\/\/api\.github\.com\/graphql/);
  assert.match(raw, /collaborators\(query:\$login,first:20\)/);
  assert.match(raw, /\.node\.login\s*\|\s*ascii_downcase/);
  assert.match(raw, /"ADMIN"/);
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
