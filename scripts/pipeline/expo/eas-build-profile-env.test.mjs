import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

import { resolveEasBuildProfileEnv } from './resolve-eas-build-profile-env.mjs';

function resolveRepoRoot() {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

test('resolveEasBuildProfileEnv: internaldev includes profile env and inherited base env', () => {
  const repoRoot = resolveRepoRoot();
  const easJsonPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');

  const env = resolveEasBuildProfileEnv({ easJsonPath, profileId: 'internaldev' });

  // From base profile (inherited via extends)
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'https://api.happier.dev');
  assert.equal(env.HAPPIER_UI_VENDOR_WEB_ASSETS, '0');

  // From internaldev profile
  assert.equal(env.APP_ENV, 'internaldev');
  assert.equal(env.EXPO_UPDATES_CHANNEL, 'internaldev');
  assert.equal(env.HAPPIER_EXPO_USE_NATIVE_DEBUG, 'true');
  assert.equal(env.EX_UPDATES_NATIVE_DEBUG, '1');
});
