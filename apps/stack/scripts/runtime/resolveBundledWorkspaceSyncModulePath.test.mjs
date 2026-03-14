import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBundledWorkspaceSyncModulePath } from './resolveBundledWorkspaceSyncModulePath.mjs';

test('resolveBundledWorkspaceSyncModulePath resolves the monorepo helper from apps/stack', () => {
  const resolved = resolveBundledWorkspaceSyncModulePath('/repo/apps/stack', {
    existsSync: (candidate) => candidate === '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs',
  });

  assert.equal(resolved, '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs');
});

test('resolveBundledWorkspaceSyncModulePath stays disabled for packaged installs without the helper', () => {
  const resolved = resolveBundledWorkspaceSyncModulePath('/usr/local/lib/node_modules/@happier-dev/stack', {
    existsSync: () => false,
  });

  assert.equal(resolved, null);
});
