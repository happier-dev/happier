import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-tauri workflow names updater assets as happier-ui-desktop-*', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-tauri.yml'), 'utf8');

  assert.match(src, /out_base="happier-ui-desktop-preview-\$\{PLATFORM_KEY\}"/);
  assert.match(src, /out_base="happier-ui-desktop-\$\{PLATFORM_KEY\}-v\$\{UI_VERSION\}"/);

  assert.doesNotMatch(src, /out_base="happier-ui-preview-/);
  assert.doesNotMatch(src, /out_base="happier-ui-\$\{PLATFORM_KEY\}-v/);
});
