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

  assert.match(raw, /node scripts\/pipeline\/run\.mjs publish-ui-web/);

  assert.doesNotMatch(raw, /deploy\//, 'ui web bundle publishing must not manage deploy/* branches');
});

test('publish-ui-web uses release bot GitHub App token for rolling tag updates', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /actions\/create-github-app-token@v1/);
  assert.match(raw, /RELEASE_BOT_APP_ID/);
  assert.match(raw, /RELEASE_BOT_PRIVATE_KEY/);
});

test('publish-ui-web supports dev and resolves auto source_ref from the selected channel', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(raw, /options:[\s\S]*?- preview[\s\S]*?- dev[\s\S]*?- stable/);
  assert.match(raw, /node scripts\/pipeline\/release\/resolve-public-release-channel-meta\.mjs/);
  assert.match(raw, /id:\s*channel_meta/);
  assert.match(raw, /ref:\s*\$\{\{\s*steps\.channel_meta\.outputs\.source_ref\s*\}\}/);
  assert.doesNotMatch(
    raw,
    /if \[ "\$src" = "auto" \]; then[\s\S]*?src="dev"[\s\S]*?src="preview"[\s\S]*?src="main"/,
  );
});

test('publish-ui-web embeds build feature policy defaults and exports production variant for stable', async () => {
  const raw = await loadWorkflow('publish-ui-web.yml');

  assert.match(
    raw,
    /HAPPIER_EMBEDDED_POLICY_ENV:\s*\$\{\{\s*steps\.channel_meta\.outputs\.embedded_policy_env\s*\}\}/,
    'ui web publishing should set HAPPIER_EMBEDDED_POLICY_ENV to production for stable bundles',
  );
  assert.match(
    raw,
    /APP_ENV:\s*\$\{\{\s*steps\.channel_meta\.outputs\.app_env\s*\}\}/,
    'ui web publishing should set APP_ENV so stable bundles use production config',
  );
  assert.match(
    raw,
    /EXPO_UPDATES_CHANNEL:\s*\$\{\{\s*steps\.channel_meta\.outputs\.expo_updates_channel\s*\}\}/,
    'ui web publishing should set EXPO_UPDATES_CHANNEL so updates headers match stable, preview, and dev channels',
  );
  assert.match(
    raw,
    /EXPO_UNSTABLE_WEB_MODAL:\s*"1"/,
    'ui web publishing should enable Expo Router web modal support for exported bundles',
  );
  assert.doesNotMatch(raw, /inputs\.channel\s*==\s*'publicdev'/);
});
