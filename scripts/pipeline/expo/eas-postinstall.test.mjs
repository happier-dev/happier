import test from 'node:test';
import assert from 'node:assert/strict';

import { runEasPostinstall } from './eas-postinstall.mjs';

test('runEasPostinstall does nothing when HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT is not enabled', async () => {
  let called = 0;
  await runEasPostinstall({
    env: {},
    ensureUiWorkspacePackagesBuilt: async () => {
      called += 1;
    },
  });
  assert.equal(called, 0);
});

test('runEasPostinstall calls ensureUiWorkspacePackagesBuilt when HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT=1', async () => {
  let called = 0;
  await runEasPostinstall({
    env: { HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT: '1' },
    ensureUiWorkspacePackagesBuilt: async ({ env }) => {
      called += 1;
      assert.equal(env.HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT, '1');
    },
  });
  assert.equal(called, 1);
});

