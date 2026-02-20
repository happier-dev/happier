import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-tauri workflow names updater assets as happier-ui-desktop-*', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-tauri.yml'), 'utf8');
  assert.match(workflow, /node scripts\/pipeline\/run\.mjs tauri-collect-updater-artifacts/);

  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'collect-updater-artifacts.mjs'), 'utf8');
  assert.match(script, /happier-ui-desktop-preview-\$\{platformKey\}/);
  assert.match(script, /happier-ui-desktop-\$\{platformKey\}-v\$\{uiVersion\}/);

  assert.doesNotMatch(script, /happier-ui-preview-/);
  assert.doesNotMatch(script, /happier-ui-\$\{platformKey\}-v/);
});
