import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type LocalServicePreviewSnapshotV1 } from '@happier-dev/protocol';

import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';

import { createExecutionRunRpcActionExecutor } from './dispatchExecutionRunRpcAction';

/**
 * G9-E cross-boundary integration: the daemon-wide server-features snapshot store, wired exactly as
 * `startDaemon` wires the Api provider, must make the runtime-action front door's feature gate read
 * the LIVE server bits on a cold daemon. This test would have caught the original bug: before the
 * Api provider had any server-features source, `getServerFeaturesSnapshot` was undefined daemon-wide
 * so a server-enabled, server-represented family (`localServices.preview`) failed closed even when
 * the server enabled it.
 *
 * It spans: store (daemon-wide source) -> context.getServerFeaturesSnapshot (Api provider bridge
 * shape) -> dispatch front door -> local-services daemon feature gate -> executor decision.
 */

function unusedBridgeMethod(): never {
  throw new Error('execution-run bridge should not be used for gated local-service action families');
}

function createUnusedExecutionRunBridge(): ExecutionRunHostBridgeContract {
  return {
    get: () => null,
    getRunningCount: () => 0,
    getStructuredMeta: () => null,
    getLatestToolResult: () => null,
    waitForTerminal: async () => unusedBridgeMethod(),
    getPublic: () => null,
    listPublic: () => [],
    listPublicForRequest: () => [],
    getDepthByRunId: () => null,
    getDepthByCallId: () => null,
    start: async () => unusedBridgeMethod(),
    send: async () => unusedBridgeMethod(),
    ensure: async () => unusedBridgeMethod(),
    ensureOrStart: async () => unusedBridgeMethod(),
    startTurnStream: async () => unusedBridgeMethod(),
    readTurnStream: async () => unusedBridgeMethod(),
    cancelTurnStream: async () => unusedBridgeMethod(),
    stop: async () => unusedBridgeMethod(),
    respondToPermissionRequest: async () => unusedBridgeMethod(),
    applyAction: async () => unusedBridgeMethod(),
  };
}

function readyServerFeatures(features: Record<string, unknown>): CliServerFeaturesSnapshot {
  return { status: 'ready', features: FeaturesResponseSchema.parse({ features }) };
}

const PREVIEW_ENABLED = readyServerFeatures({
  localServices: {
    enabled: true,
    inventory: { enabled: true },
    preview: { enabled: true },
  },
});

const PREVIEW_DISABLED = readyServerFeatures({
  localServices: {
    enabled: true,
    inventory: { enabled: true },
    preview: { enabled: false },
  },
});

const PREVIEW_SNAPSHOT: LocalServicePreviewSnapshotV1 = {
  v: 1,
  machineId: 'machine_1',
  generatedAt: 2_000,
  refreshState: 'idle',
  resources: [],
  diagnostics: [],
};

const PREVIEW_STATUS_INPUT = { machineId: 'machine_1', sessionId: 'session_1' } as const;

function createGatedPreviewExecutor(params: {
  getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot | undefined;
  getSnapshot: () => Promise<typeof PREVIEW_SNAPSHOT>;
}) {
  return createExecutionRunRpcActionExecutor({
    manager: createUnusedExecutionRunBridge(),
    context: {
      sessionId: 'session_1',
      cwd: '/workspace',
      localServices: { previewRoutes: { getSnapshot: params.getSnapshot } },
      getServerFeaturesSnapshot: params.getServerFeaturesSnapshot,
    },
    policy: resolveExecutionRunPolicy({
      defaults: {
        maxConcurrentRuns: null,
        boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null,
        maxTurns: null,
        maxDepth: 3,
      },
    }),
    isExecutionRunsEnabled: () => true,
  });
}

describe('server-features cold-daemon runtime-action gate (G9-E)', () => {
  it('fails closed on a cold daemon before the store is primed (the chokepoint)', async () => {
    const getSnapshot = vi.fn(async () => PREVIEW_SNAPSHOT);
    // The store can fetch an enabled snapshot, but it has not been primed yet — exactly the cold
    // daemon state the bug shipped as a permanent state (provider undefined daemon-wide).
    const store = createServerFeaturesSnapshotStore({ fetchSnapshot: async () => PREVIEW_ENABLED });
    const executor = createGatedPreviewExecutor({
      getServerFeaturesSnapshot: () => store.getSnapshot(),
      getSnapshot,
    });

    const result = await executor.execute('localServices.preview.status', PREVIEW_STATUS_INPUT);

    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:localServices:feature_disabled:localServices.preview',
    });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('resolves enabled on a cold daemon once the store is primed with the server bit on', async () => {
    const getSnapshot = vi.fn(async () => PREVIEW_SNAPSHOT);
    const store = createServerFeaturesSnapshotStore({ fetchSnapshot: async () => PREVIEW_ENABLED });
    const executor = createGatedPreviewExecutor({
      getServerFeaturesSnapshot: () => store.getSnapshot(),
      getSnapshot,
    });

    // Mirror the daemon startup prime: a single fetch warms the daemon-wide cache.
    await store.refresh();

    const result = await executor.execute('localServices.preview.status', PREVIEW_STATUS_INPUT);

    expect(result).toEqual({ ok: true, result: PREVIEW_SNAPSHOT });
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it('fails closed when the server bit is off', async () => {
    const getSnapshot = vi.fn(async () => PREVIEW_SNAPSHOT);
    const store = createServerFeaturesSnapshotStore({ fetchSnapshot: async () => PREVIEW_DISABLED });
    const executor = createGatedPreviewExecutor({
      getServerFeaturesSnapshot: () => store.getSnapshot(),
      getSnapshot,
    });

    await store.refresh();

    const result = await executor.execute('localServices.preview.status', PREVIEW_STATUS_INPUT);

    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:localServices:feature_disabled:localServices.preview',
    });
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});
