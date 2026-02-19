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

test('build-tauri publishes desktop releases under ui-desktop-* tags', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /tag:\s*ui-desktop-preview\b/);
  assert.match(raw, /tag:\s*ui-desktop-v\$\{\{\s*needs\.prepare_assets\.outputs\.ui_version\s*\}\}/);
  assert.match(raw, /tag:\s*ui-desktop-stable\b/);

  assert.doesNotMatch(raw, /tag:\s*ui-preview\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-stable\b/);
  assert.doesNotMatch(raw, /tag:\s*ui-v\$\{\{/);
});

test('build-tauri latest.json generator uses ui-desktop-* release tags and publish assets are namespaced', async () => {
  const raw = await loadWorkflow('build-tauri.yml');

  assert.match(raw, /node scripts\/pipeline\/tauri\/prepare-publish-assets\.mjs/);

  const script = await loadFile('scripts/pipeline/tauri/prepare-publish-assets.mjs');
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-v\$\{uiVersion\}/);

  assert.match(script, /dist\/tauri\/publish/);
  assert.match(script, /ui-desktop-preview/);
  assert.match(script, /ui-desktop-v/);
  assert.match(script, /ui-desktop-stable/);

  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-preview\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-v\b/);
  assert.doesNotMatch(raw, /dist\/tauri\/publish\/ui-stable\b/);

  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-preview/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-v/);
  assert.match(raw, /assets_dir:\s*dist\/ui-desktop-assets\/ui-desktop-stable/);
});
