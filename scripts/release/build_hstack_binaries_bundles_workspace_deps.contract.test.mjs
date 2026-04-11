import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

test('build-hstack-binaries prepares bundled workspace dependencies before compiling', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'pipeline', 'release', 'build-hstack-binaries.mjs'),
    'utf8',
  );

  assert.match(src, /bundleWorkspaceDeps/, 'expected build-hstack-binaries to import bundled workspace preparation');
  assert.match(
    src,
    /await bundleWorkspaceDeps\(\{\s*repoRoot,\s*stackDir:\s*join\(repoRoot,\s*'apps',\s*'stack'\)\s*\}\)/,
    'expected build-hstack-binaries to prepare apps/stack bundled workspace deps before bun compile',
  );
});
