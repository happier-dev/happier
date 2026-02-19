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

test('promote-ui publishes mobile assets under ui-mobile-* GitHub release tags', async () => {
  const raw = await loadWorkflow('promote-ui.yml');

  assert.match(raw, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);

  const script = await loadFile('scripts/pipeline/expo/publish-apk-release.mjs');
  assert.match(script, /ui-mobile-v\$\{appVersion\}/);
  assert.match(script, /ui-mobile-preview/);

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

  assert.match(raw, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);

  const script = await loadFile('scripts/pipeline/expo/publish-apk-release.mjs');
  assert.match(script, /Happier UI Mobile v\$\{appVersion\}/);
  assert.match(script, /Happier UI Mobile Preview/);

  assert.doesNotMatch(raw, /echo "title=Happier UI v/);
  assert.doesNotMatch(raw, /echo "title=Happier UI Preview"/);
  assert.doesNotMatch(raw, /format\('Happier UI v\{0\}'/);
  assert.doesNotMatch(raw, /'Happier UI Preview'/);
});
