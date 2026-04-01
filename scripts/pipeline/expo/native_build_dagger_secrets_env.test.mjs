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

test('native-build passes EXPO_TOKEN/SENTRY_AUTH_TOKEN into the dagger CLI env for env:// secrets', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  // We pass dagger Secret args using env://NAME indirections. That requires the dagger CLI
  // process environment to contain the referenced vars, otherwise Dagger resolves them as Missing.
  assert.match(
    src,
    /daggerEnv[\s\S]*EXPO_TOKEN[\s\S]*SENTRY_AUTH_TOKEN[\s\S]*run\([\s\S]*['"]dagger['"][\s\S]*env:\s*daggerEnv/s,
    'expected native-build to pass a daggerEnv containing EXPO_TOKEN and SENTRY_AUTH_TOKEN to the dagger exec',
  );
});

