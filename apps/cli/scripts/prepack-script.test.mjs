import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('apps/cli prepack builds dist for npm pack', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prepack = String(pkg?.scripts?.prepack ?? '');
  assert.ok(prepack.includes('build'), `expected scripts.prepack to include a build step, got: ${prepack || '(missing)'}`);
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
