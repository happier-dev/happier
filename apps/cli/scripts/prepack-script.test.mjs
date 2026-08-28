import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('apps/cli prepack builds dist for npm pack', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prepack = String(pkg?.scripts?.prepack ?? '');
  assert.ok(prepack.includes('build'), `expected scripts.prepack to include a build step, got: ${prepack || '(missing)'}`);
  const buildIndex = prepack.indexOf('build');
  const syncIndex = prepack.indexOf('syncPackageDist.mjs');
  const bundleIndex = prepack.indexOf('bundleWorkspaceDeps.mjs');
  assert.ok(syncIndex > buildIndex, `expected package dist sync after build, got: ${prepack}`);
  assert.ok(bundleIndex > syncIndex, `expected workspace dependency bundling after package dist sync, got: ${prepack}`);
});

test('apps/cli has one canonical packer and no postpack archive rewriter', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(
    pkg?.scripts?.postpack,
    undefined,
    'the canonical packTarball helper must own the final archive instead of a lifecycle-only rewriter',
  );
});

test('apps/cli npm files list ships archives (not unpacked tools)', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const files = Array.isArray(pkg?.files) ? pkg.files.map((v) => String(v)) : [];

  assert.ok(files.includes('dist'), 'expected dist to be shipped');
  assert.ok(files.includes('bin'), 'expected bin to be shipped');

  assert.ok(files.includes('tools/archives'), 'expected tools/archives to be shipped');
  assert.ok(files.includes('tools/licenses'), 'expected tools/licenses to be shipped');

  assert.ok(!files.includes('tools'), 'expected not to ship entire tools/ tree (would include unpacked binaries)');
  assert.ok(!files.includes('tools/unpacked'), 'expected tools/unpacked to be excluded');
});

test('apps/cli npm files list ships deferred voice runtime bootstrap scripts', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const files = Array.isArray(pkg?.files) ? pkg.files.map((v) => String(v)) : [];

  assert.ok(
    files.includes('scripts/runtime/**') || files.includes('scripts/runtime/loadVoiceInferenceRuntime.mjs'),
    'expected npm files whitelist to ship scripts/runtime/loadVoiceInferenceRuntime.mjs',
  );
});
