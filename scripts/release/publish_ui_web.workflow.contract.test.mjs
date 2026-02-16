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

test('publish-ui-web workflow exists and is a dedicated rolling release publisher', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /name:\s*PUBLISH\s+—\s+UI Web Bundle/i);
  assert.match(raw, /workflow_dispatch:/);
  assert.match(raw, /workflow_call:/);

  assert.match(raw, /ui-web-preview/);
  assert.match(raw, /rolling_tag/);
  assert.match(raw, /uses:\s*\.\/\.github\/workflows\/publish-github-release\.yml/);

  assert.doesNotMatch(raw, /deploy\//, 'ui web bundle publishing must not manage deploy/* branches');
});

test('publish-ui-web uses release bot GitHub App token for rolling tag updates', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /actions\/create-github-app-token@v1/);
  assert.match(raw, /RELEASE_BOT_APP_ID/);
  assert.match(raw, /RELEASE_BOT_PRIVATE_KEY/);
});

test('publish-ui-web embeds build feature policy defaults and exports production variant for stable', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(
    raw,
    /HAPPIER_EMBEDDED_POLICY_ENV:\s*\$\{\{\s*inputs\.channel\s*==\s*'stable'\s*&&\s*'production'\s*\|\|\s*'preview'\s*\}\}/,
    'ui web publishing should set HAPPIER_EMBEDDED_POLICY_ENV to production for stable bundles',
  );
  assert.match(
    raw,
    /APP_ENV:\s*\$\{\{\s*inputs\.channel\s*==\s*'stable'\s*&&\s*'production'\s*\|\|\s*'preview'\s*\}\}/,
    'ui web publishing should set APP_ENV so stable bundles use production config',
  );
  assert.match(
    raw,
    /EXPO_UPDATES_CHANNEL:\s*\$\{\{\s*inputs\.channel\s*==\s*'stable'\s*&&\s*'production'\s*\|\|\s*'preview'\s*\}\}/,
    'ui web publishing should set EXPO_UPDATES_CHANNEL so updates headers match the release channel',
  );
});
