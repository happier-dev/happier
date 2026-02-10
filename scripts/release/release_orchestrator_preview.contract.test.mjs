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

test('release workflow only promotes/bumps on production and routes source_ref by environment', async () => {
  const raw = await loadWorkflow('release.yml');

  assert.match(raw, /promote_main:[\s\S]*?if:\s*inputs\.dry_run != true && inputs\.environment == 'production'/);
  assert.match(raw, /bump_versions:[\s\S]*?if:\s*inputs\.dry_run != true && inputs\.environment == 'production'/);
  assert.match(raw, /if \[ "\$env_name" = "preview" \]; then[\s\S]*?if \[ "\$confirm" != "release preview from dev" \]; then/);
  assert.doesNotMatch(raw, /\[ "\$confirm" != "release preview from dev" \] && \[ "\$confirm" != "release dev to main" \]/);

  assert.match(raw, /source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'dev' \}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'dev' \}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?bump:\s*\$\{\{\s*inputs\.environment == 'preview' && inputs\.cli_release_bump \|\| 'none'\s*\}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?stack_bump:\s*\$\{\{\s*inputs\.environment == 'preview' && inputs\.stack_release_bump \|\| 'none'\s*\}\}/);
  assert.match(raw, /sync_dev:[\s\S]*?if:\s*inputs\.dry_run != true && inputs\.environment == 'production'/);
});

test('release-npm resolves source ref from channel and checks out resolved source', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?source_ref:/);
  assert.match(raw, /workflow_call:[\s\S]*?inputs:[\s\S]*?source_ref:/);

  assert.match(raw, /if \[ "\$src" = "auto" \]; then[\s\S]*?if \[ "\$channel" = "preview" \]; then[\s\S]*?src="dev"[\s\S]*?src="main"/);
  assert.match(raw, /ref:\s*\$\{\{ steps\.resolve_source\.outputs\.ref \}\}/);
});

test('release-npm is compatible with npm trusted publishing (OIDC)', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /npm install --global npm@11/);
  assert.doesNotMatch(raw, /NPM_TOKEN is required for npm publish\./);
});

test('release-npm can derive preview versions from requested bump level', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /function bumpBase\(base, bump\)/);
  assert.match(raw, /versions\.cli = setPreviewVersion\(join\('apps', 'cli', 'package\.json'\), process\.env\.CLI_PREVIEW_BUMP\);/);
  assert.match(raw, /versions\.stack = setPreviewVersion\(join\('apps', 'stack', 'package\.json'\), process\.env\.STACK_PREVIEW_BUMP\);/);
  assert.match(raw, /CLI_PREVIEW_BUMP:\s*\$\{\{\s*inputs\.bump\s*\}\}/);
  assert.match(raw, /STACK_PREVIEW_BUMP:\s*\$\{\{\s*inputs\.stack_bump\s*\}\}/);
});
