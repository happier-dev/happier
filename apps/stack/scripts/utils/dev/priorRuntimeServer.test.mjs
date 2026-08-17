import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDevPriorRuntimeServer,
  shouldPreflightDevRestart,
} from './priorRuntimeServer.mjs';

test('dev prior-runtime admission ignores source freshness and returns the structurally valid server launch', async () => {
  const snapshot = {
    snapshotId: 'old-but-runnable',
    sourceFingerprint: 'source-from-yesterday',
    snapshotPath: '/tmp/runtime/builds/old-but-runnable',
    manifest: {
      source: { serverComponent: 'happier-server-light' },
      components: { server: { entrypoint: 'server/happier-server' } },
    },
  };

  const result = await resolveDevPriorRuntimeServer(
    {
      stackBaseDir: '/tmp/stack',
      serverComponentName: 'happier-server-light',
    },
    {
      inspectActiveRuntimeSnapshotImpl: async () => ({ snapshot }),
    },
  );

  assert.equal(result.admitted, true);
  assert.equal(result.snapshotId, 'old-but-runnable');
  assert.equal(result.sourceFingerprint, 'source-from-yesterday');
  assert.equal(result.launchSpec.command, '/tmp/runtime/builds/old-but-runnable/server/happier-server');
});

test('dev prior-runtime admission rejects a structurally invalid or server-mismatched snapshot', async () => {
  assert.deepEqual(
    await resolveDevPriorRuntimeServer(
      { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server-light' },
      { inspectActiveRuntimeSnapshotImpl: async () => ({ snapshot: null, errors: ['missing server entrypoint'] }) },
    ),
    { admitted: false, reason: 'invalid_snapshot', detail: 'missing server entrypoint' },
  );

  const mismatch = await resolveDevPriorRuntimeServer(
    { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server-light' },
    {
      inspectActiveRuntimeSnapshotImpl: async () => ({
        snapshot: {
          snapshotPath: '/tmp/runtime/builds/full',
          manifest: {
            source: { serverComponent: 'happier-server' },
            components: { server: { entrypoint: 'server/happier-server' } },
          },
        },
      }),
    },
  );
  assert.equal(mismatch.admitted, false);
  assert.equal(mismatch.reason, 'server_component_mismatch');
});

test('dev prior-runtime admission stays source-only for the full server until managed-infra bootstrap is supported', async () => {
  let inspected = false;
  const result = await resolveDevPriorRuntimeServer(
    { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server' },
    {
      inspectActiveRuntimeSnapshotImpl: async () => {
        inspected = true;
        return { snapshot: null };
      },
    },
  );

  assert.deepEqual(result, {
    admitted: false,
    reason: 'unsupported_server_component',
    detail: null,
  });
  assert.equal(inspected, false);
});

test('a runnable prior runtime replaces the blocking outer restart preflight', () => {
  assert.equal(shouldPreflightDevRestart({
    startServer: true,
    priorRuntimeServer: { admitted: true },
  }), false);
  assert.equal(shouldPreflightDevRestart({
    startServer: true,
    priorRuntimeServer: { admitted: false },
  }), true);
  assert.equal(shouldPreflightDevRestart({
    startServer: false,
    priorRuntimeServer: { admitted: false },
  }), false);
});
