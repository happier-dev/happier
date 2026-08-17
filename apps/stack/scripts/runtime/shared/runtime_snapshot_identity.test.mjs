import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeSnapshotId,
  createRuntimeSnapshotSourceMetadata,
} from './runtime_snapshot_identity.mjs';

test('runtime snapshot identity is derived from exact component artifacts and recipe inputs', () => {
  const base = {
    sourceMetadata: {
      repoDir: '/work/happier',
      commitSha: 'abc123',
      dirtyHash: 'dirty',
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
    },
    componentFingerprints: {
      web: 'web-a',
      server: 'server-a',
      daemon: 'daemon-a',
    },
    platform: 'darwin',
    arch: 'arm64',
    buildInputs: ['bun=1.2.3', 'expo=54'],
  };

  const first = createRuntimeSnapshotId(base);
  const reordered = createRuntimeSnapshotId({
    ...base,
    componentFingerprints: {
      daemon: 'daemon-a',
      server: 'server-a',
      web: 'web-a',
    },
    buildInputs: ['expo=54', 'bun=1.2.3'],
  });
  const changedWeb = createRuntimeSnapshotId({
    ...base,
    componentFingerprints: { ...base.componentFingerprints, web: 'web-b' },
  });
  const changedCheckoutProvenance = createRuntimeSnapshotId({
    ...base,
    sourceMetadata: {
      ...base.sourceMetadata,
      commitSha: 'def456',
      dirtyHash: 'different-unrelated-work',
      repoDir: '/another/physical/checkout/path',
    },
  });
  const changedServerRecipe = createRuntimeSnapshotId({
    ...base,
    sourceMetadata: {
      ...base.sourceMetadata,
      serverComponent: 'happier-server',
      dbProvider: 'mysql',
    },
  });

  assert.match(first, /^[a-f0-9]{16}$/);
  assert.equal(reordered, first);
  assert.equal(changedCheckoutProvenance, first);
  assert.notEqual(changedWeb, first);
  assert.notEqual(changedServerRecipe, first);
});

test('runtime snapshot source identity is normalized to the exact published artifact set', () => {
  const sourceMetadata = {
    repoDir: '/work/happier',
    commitSha: 'abc123',
    dirtyHash: 'dirty',
    sourceFingerprint: 'moving-checkout-source',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    builtAt: '2026-08-16T10:00:00.000Z',
  };

  assert.deepEqual(
    createRuntimeSnapshotSourceMetadata({ sourceMetadata, snapshotId: 'snapshot-artifact-set' }),
    {
      ...sourceMetadata,
      buildSourceFingerprint: 'moving-checkout-source',
      sourceFingerprint: 'snapshot-artifact-set',
    },
  );
});
