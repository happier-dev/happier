import { mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerTestCleanup, removeDirForce, removeDirForceSync } from '../../utils/test/test_cleanup.mjs';

function buildFixtureApi(root, cleanup) {
  return {
    root,
    cleanup,
    path(...segments) {
      return join(root, ...segments);
    },
  };
}

export async function createTempFixture(t, {
  prefix = 'hstack-test-fixture-',
  parentDir = tmpdir(),
  registerCleanup = true,
} = {}) {
  const root = await mkdtemp(join(parentDir, prefix));
  const cleanup = async () => {
    await removeDirForce(root);
  };
  if (registerCleanup) registerTestCleanup(t, cleanup);
  return buildFixtureApi(root, cleanup);
}

export function createTempFixtureSync(t, {
  prefix = 'hstack-test-fixture-',
  parentDir = tmpdir(),
  registerCleanup = true,
} = {}) {
  const root = mkdtempSync(join(parentDir, prefix));
  const cleanup = () => {
    removeDirForceSync(root);
  };
  if (registerCleanup) registerTestCleanup(t, cleanup);
  return buildFixtureApi(root, cleanup);
}
