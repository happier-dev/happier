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

test('dagger expoAndroidLocalBuild uses yarn-install-with-retry to tolerate transient registry failures', () => {
  const src = readRepoFile('dagger/src/index.ts');

  assert.match(
    src,
    /scripts\/ci\/yarn-install-with-retry\.sh/,
    'expected expoAndroidLocalBuild to invoke scripts/ci/yarn-install-with-retry.sh (not raw yarn install)',
  );
});
