import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local uses direct local native_submit instead of artifact relay submit jobs', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');

  assert.doesNotMatch(src, /\n\s*submit_android:/);
  assert.doesNotMatch(src, /\n\s*submit_ios:/);
  assert.doesNotMatch(src, /actions\/download-artifact@v4/);
  assert.doesNotMatch(src, /Resolve downloaded build artifact path/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-submit/);
  assert.match(src, /--action "\$\{\{\s*inputs\.action == 'build_and_submit' && 'native_submit' \|\| 'native'\s*\}\}"/);
});
