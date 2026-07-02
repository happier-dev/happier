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

test('native-build passes EXPO_TOKEN/SENTRY_AUTH_TOKEN and Expo web-modal env into the dagger CLI env', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  // We pass dagger Secret args using env://NAME indirections. That requires the dagger CLI
  // process environment to contain the referenced vars, otherwise Dagger resolves them as Missing.
  // Keep the Expo web-modal flag in that same subprocess env so local dagger builds match cloud/local EAS behavior.
  assert.match(
    src,
    /const expoWebModalEnv = \{ EXPO_UNSTABLE_WEB_MODAL: '1' \};[\s\S]*const daggerEnv = \{[\s\S]*\.\.\.expoWebModalEnv[\s\S]*EXPO_TOKEN: expoToken[\s\S]*SENTRY_AUTH_TOKEN[\s\S]*run\([\s\S]*['"]dagger['"][\s\S]*env:\s*daggerEnv/s,
    'expected native-build to pass a daggerEnv containing EXPO_UNSTABLE_WEB_MODAL, EXPO_TOKEN, and SENTRY_AUTH_TOKEN to the dagger exec',
  );
});
