import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPinnedRunnerSnapshotModule } from './pinnedRunnerSnapshotLoader.mjs';

const readySelector = () => null;
const canonicalModule = {
  isPinnedRunnerSnapshotReady() {},
  listReadyPinnedRunnerSnapshots() {},
  resolveNewestReadyPinnedRunnerSnapshot: readySelector,
};

test('pinned runner selector uses the mounted package owner before source fallback', async () => {
  const selected = await loadPinnedRunnerSnapshotModule({
    importPackageModule: async () => canonicalModule,
    sourceModulePath: '/canonical/pinnedRunnerSnapshot.mjs',
    existsSyncImpl: () => true,
    importModule: async () => {
      throw new Error('a complete mounted package must not fall back to the repository source');
    },
  });

  assert.equal(selected, canonicalModule);
});

test('pinned runner selector falls back only when a canonical source module is present', async () => {
  let sourceLoads = 0;
  const selected = await loadPinnedRunnerSnapshotModule({
    importPackageModule: async () => ({
      resolveNewestReadyPinnedRunnerSnapshot: readySelector,
    }),
    sourceModulePath: '/canonical/pinnedRunnerSnapshot.mjs',
    existsSyncImpl: () => true,
    importModule: async () => {
      sourceLoads += 1;
      return canonicalModule;
    },
  });

  assert.equal(selected, canonicalModule);
  assert.equal(sourceLoads, 1);
});

test('pinned runner selector never invents a repository fallback for an installed package', async () => {
  await assert.rejects(
    () => loadPinnedRunnerSnapshotModule({
      importPackageModule: async () => {
        throw new Error('installed package export is unavailable');
      },
      sourceModulePath: '/absent/repository/packages/cli-common/pinnedRunnerSnapshot.mjs',
      existsSyncImpl: () => false,
    }),
    /installed package export is unavailable/,
  );
});
