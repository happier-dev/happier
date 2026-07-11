import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveWorkspaceBundleLockPath } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import {
  resolvePluginSdkWorkspaceBuildOrder,
  resolvePluginSdkWorkspaceBundleLockPath,
} from './bundleWorkspaceDeps.mjs';

test('plugin-sdk workspace bundling uses the canonical repository bundle lock by default', () => {
  const repoRoot = '/repo';

  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot }),
    resolveWorkspaceBundleLockPath(repoRoot),
  );
});

test('plugin-sdk workspace bundling preserves an explicit lock override', () => {
  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot: '/repo', lockPath: '/tmp/explicit.lock' }),
    '/tmp/explicit.lock',
  );
});

test('plugin-sdk bootstrap builds the complete cli-common dependency closure first', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  assert.deepEqual(resolvePluginSdkWorkspaceBuildOrder({ repoRoot }), [
    'protocol',
    'agents',
    'release-runtime',
    'cli-common',
  ]);
});
