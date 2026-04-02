import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('dagger expoAndroidLocalBuild caps NODE_OPTIONS to reduce OOM risk during export:embed', () => {
  const src = readRepoFile('dagger/src/index.ts');
  assert.match(src, /withEnvVariable\(\s*["']NODE_OPTIONS["']/, 'expected NODE_OPTIONS to be set for expoAndroidLocalBuild');
  assert.match(
    src,
    /--max-old-space-size=/,
    'expected expoAndroidLocalBuild to set NODE_OPTIONS with --max-old-space-size',
  );
});

