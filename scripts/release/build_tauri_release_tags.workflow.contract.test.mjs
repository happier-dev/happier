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

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

async function loadCanonicalUiInstallScope() {
  const easJson = JSON.parse(await loadFile('apps/ui/eas.json'));
  return String(easJson?.build?.base?.env?.HAPPIER_INSTALL_SCOPE ?? '');
}

test('build-tauri publishes desktop releases under ui-desktop-* tags', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /tag:\s*ui-desktop-preview\b/);
  assert.match(raw, /tag:\s*ui-desktop-dev\b/);
  assert.match(raw, /tag:\s*ui-desktop-v\$\{\{\s*needs\.prepare_assets\.outputs\.ui_version\s*\}\}/);
  assert.match(raw, /--rolling-tag\s+ui-desktop-stable\b/);

  assert.doesNotMatch(raw, /tag:\s*ui-preview\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-stable\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-v\$\{\{/);
});

test('build-tauri keeps the public manual workflow surface on dev while retaining internal dev release tags', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /Environment — Controls config \(preview\|dev\|production\)/);
  assert.match(raw, /options:\s*\n(?:\s+- .*\n)*\s+- dev\b/);
  assert.doesNotMatch(raw, /Environment — Controls config \(preview\|publicdev\|production\)/);
  assert.doesNotMatch(raw, /^\s+- publicdev$/m);

  assert.match(raw, /publish_dev:/);
  assert.doesNotMatch(raw, /publish_publicdev:/);
  assert.match(raw, /tag:\s*ui-desktop-dev\b/);
  assert.doesNotMatch(raw, /inputs\.environment\s*==\s*'publicdev'/);
});

test('build-tauri enables Expo Router web modal support for desktop UI builds', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /EXPO_UNSTABLE_WEB_MODAL:\s*"1"/);
});

test('build-tauri latest.json generator uses ui-desktop-* release tags and publish assets are namespaced', async () => {
  const raw = await loadWorkflow('build-tauri.yml');
  const expectedScope = await loadCanonicalUiInstallScope();

  assert.match(raw, /node scripts\/pipeline\/run\.mjs tauri-prepare-assets/);
  const scopeMatches = [...raw.matchAll(/HAPPIER_INSTALL_SCOPE:\s*"([^"]+)"/g)];
  assert.ok(scopeMatches.length > 0, 'build-tauri.yml should define HAPPIER_INSTALL_SCOPE');
  for (const [, scope = ''] of scopeMatches) {
    assert.equal(scope, expectedScope);
  }

  const script = await loadFile('scripts/pipeline/tauri/prepare-publish-assets.mjs');
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-dev/);
  assert.match(script, /ui-desktop-v\$\{uiVersion\}/);

  assert.match(script, /dist\/tauri\/publish/);
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-dev/);
  assert.match(script, /ui-desktop-v/);
  assert.match(script, /createSignedReleaseAssetEnvelope/);

  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-preview\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-v\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-stable\b/);

  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-preview/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-dev/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-v/);
  assert.doesNotMatch(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-stable/);
});

test('build-tauri publishes the immutable production desktop envelope before the staged stable projection', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(
    raw,
    /publish_stable_release:\n(?:.*\n){0,18}\s+rolling_tag:\s*false\b/,
  );
  assert.match(raw, /publish_stable_release:\n(?:.*\n){0,24}\s+clobber:\s*false\b/);
  assert.match(raw, /promote_stable_feed:/);
  assert.match(raw, /node scripts\/pipeline\/github\/promote-rolling-release\.mjs/);
  assert.match(raw, /SOURCE_TAG:\s*ui-desktop-v\$\{\{[^\n]+\}\}/);
  assert.match(raw, /--source-tag\s+"\$SOURCE_TAG"/);
  assert.match(raw, /--rolling-tag\s+ui-desktop-stable\b/);
  assert.doesNotMatch(raw, /publish_stable_feed:/);
});

test('build-tauri uses approved candidate notes instead of generated GitHub notes', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /release_message:/);
  assert.match(raw, /release_notes_github_markdown/);
  assert.match(raw, /publish_preview:[\s\S]*?needs:\s*\[prepare_assets,\s*resolve_source\]/);
  assert.match(raw, /publish_dev:[\s\S]*?needs:\s*\[prepare_assets,\s*resolve_source\]/);
  assert.match(raw, /publish_stable_release:[\s\S]*?generate_notes:\s*false/);
  assert.match(raw, /publish_stable_release:[\s\S]*?notes:\s*\$\{\{\s*needs\.resolve_source\.outputs\.release_notes_github_markdown\s*\}\}/);
  assert.match(raw, /promote-rolling-release\.mjs[\s\S]*?RELEASE_MESSAGE/);
  assert.equal(
    raw.includes('appendFileSync(process.env.GITHUB_OUTPUT, `release_notes_github_markdown<<${delimiter}\\n${value}\\n${delimiter}\\n`);'),
    true,
  );
  assert.equal(
    raw.includes('appendFileSync(process.env.GITHUB_OUTPUT, `release_notes_github_markdown<<${delimiter}\\\\n${value}\\\\n${delimiter}\\\\n`);'),
    false,
  );
});

test('build-tauri can reproject an exact immutable production version without running a new build', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /retry_version:/);
  assert.match(raw, /RETRY_VERSION:\s*\$\{\{\s*inputs\.retry_version\s*\}\}/);
  assert.match(raw, /needs\.resolve_source\.outputs\.retry_version/);
  assert.match(raw, /Build desktop candidate[\s\S]{0,220}if:\s*\$\{\{\s*needs\.resolve_source\.outputs\.retry_version\s*==\s*''\s*\}\}/);
  assert.match(raw, /SOURCE_TAG:\s*ui-desktop-v\$\{\{\s*needs\.resolve_source\.outputs\.retry_version/);
  assert.doesNotMatch(raw, /retry_version must match apps\/ui\/package\.json version/);
  assert.match(raw, /inputs\.retry_version != ''[\s\S]*?ui-desktop-v/);
});
