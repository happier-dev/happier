import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local workflow delegates local builds to ui-mobile-release pipeline command', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(src, /--native-build-mode local/);
  assert.match(src, /--action "\$\{\{\s*inputs\.action == 'build_and_submit' && 'native_submit' \|\| 'native'\s*\}\}"/);
  assert.match(src, /--publish-apk-release false/);
  assert.match(src, /-\s+internaldev\b/);
  assert.match(src, /-\s+internalpreview\b/);
  assert.match(src, /-\s+dev\b/);
  assert.match(src, /-\s+internaldev-store\b/);
  assert.match(src, /-\s+internalpreview-apk\b/);
  assert.match(src, /-\s+dev-apk\b/);
  assert.match(src, /-\s+preview-apk\b/);
  assert.match(src, /-\s+production-apk\b/);
  assert.match(src, /-\s+ota\b/);
  assert.doesNotMatch(src, /inputs\.environment == 'publicdev'/);
  assert.doesNotMatch(src, /\benv_name\b[\s\S]*?"publicdev"/);
  assert.doesNotMatch(src, /-\s+production-preview\b/);
  assert.doesNotMatch(src, /-\s+production-preview-apk\b/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-submit/);
});
