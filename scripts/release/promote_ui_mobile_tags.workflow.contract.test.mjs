import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

async function loadMobileReleaseEnvironmentsModule() {
  const moduleUrl = pathToFileURL(join(repoRoot, 'scripts', 'pipeline', 'expo', 'mobile-release-environments.mjs'));
  return import(`${moduleUrl.href}?cacheBust=${Date.now()}`);
}

test('promote-ui publishes mobile assets under ui-mobile-* GitHub release tags', async () => {
  const raw = await loadWorkflow('promote-ui.yml');

  assert.match(raw, /uses:\s*\.\/\.github\/workflows\/build-ui-mobile-local\.yml/);

  const { resolveMobileReleaseMetadata } = await loadMobileReleaseEnvironmentsModule();
  assert.equal(resolveMobileReleaseMetadata({ environment: 'production', appVersion: '1.2.3' }).tag, 'ui-mobile-v1.2.3');
  assert.equal(resolveMobileReleaseMetadata({ environment: 'preview', appVersion: '1.2.3' }).tag, 'ui-mobile-preview');
  assert.equal(resolveMobileReleaseMetadata({ environment: 'publicdev', appVersion: '1.2.3' }).tag, 'ui-mobile-dev');

  assert.doesNotMatch(raw, /echo "tag=ui-v/);
  assert.doesNotMatch(raw, /echo "tag=ui-preview"/);
  assert.doesNotMatch(raw, /format\('ui-v\{0\}'/);
  assert.doesNotMatch(raw, /'ui-preview'/);

  assert.doesNotMatch(raw, /publish_mobile_local:/);
  assert.doesNotMatch(raw, /uses:\s*\.\/\.github\/workflows\/publish-ui-release\.yml/);
  assert.doesNotMatch(raw, /needs\.promote\.outputs\.app_version/);
});

test('promote-ui labels mobile releases as UI Mobile for clarity', async () => {
  const raw = await loadWorkflow('promote-ui.yml');

  assert.match(raw, /uses:\s*\.\/\.github\/workflows\/build-ui-mobile-local\.yml/);

  const { resolveMobileReleaseMetadata } = await loadMobileReleaseEnvironmentsModule();
  assert.equal(resolveMobileReleaseMetadata({ environment: 'production', appVersion: '1.2.3' }).title, 'Happier UI Mobile v1.2.3');
  assert.equal(resolveMobileReleaseMetadata({ environment: 'preview', appVersion: '1.2.3' }).title, 'Happier UI Mobile Preview');
  assert.equal(resolveMobileReleaseMetadata({ environment: 'publicdev', appVersion: '1.2.3' }).title, 'Happier UI Mobile Dev');

  assert.doesNotMatch(raw, /echo "title=Happier UI v/);
  assert.doesNotMatch(raw, /echo "title=Happier UI Preview"/);
  assert.doesNotMatch(raw, /format\('Happier UI v\{0\}'/);
  assert.doesNotMatch(raw, /'Happier UI Preview'/);
});

test('promote-ui runs a dedicated public APK release build for preview and production lanes', async () => {
  const raw = await loadWorkflow('promote-ui.yml');

  assert.match(raw, /uses:\s*\.\/\.github\/workflows\/build-ui-mobile-local\.yml/);
  assert.match(raw, /platform:\s*android/);
  assert.match(raw, /profile:\s*\$\{\{\s*inputs\.environment == 'production' && 'production-apk' \|\| 'preview-apk'\s*\}\}/);
  assert.match(raw, /publish_apk_release:\s*"true"/);
});
