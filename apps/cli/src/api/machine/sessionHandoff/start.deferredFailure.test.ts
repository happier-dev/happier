import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionHandoffStartActionHandler } from './start';

describe('session handoff deferred start settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists an exact source_stop_failed code when the fast path settles after acknowledgement', async () => {
    vi.useFakeTimers();
    let resolveStop!: (value: 'failed') => void;
    const stopSessionForHandoff = vi.fn(
      async () => await new Promise<'failed'>((resolve) => {
        resolveStop = resolve;
      }),
    );
    const prepareJobStoreWrite = vi.fn(async () => undefined);
    const sourceExportSave = vi.fn(async () => undefined);
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-deferred-failure-test',
      createUuid: () => 'deferred-failure',
      loadSessionMetadata: async () => ({ path: '/tmp/project' }),
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      stopSessionForHandoff,
      prepareJobStore: { write: prepareJobStoreWrite },
      sourceExportStore: {
        save: sourceExportSave,
        writeAgentBundleFile: vi.fn(),
      } as never,
      prepareStartedState: vi.fn() as never,
      exportSessionBundle: vi.fn() as never,
      waitForPersistedSourceExport: vi.fn() as never,
      invalidateDirectPeerRouteCacheForHandoffMachines: vi.fn(),
      resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
      buildStartPendingStatus: (input) => ({
        handoffId: input.handoffId,
        status: 'pending',
        phase: 'preparing',
        recoveryActions: [],
      }),
      buildStartRecoveryStatus: (handoffId) => ({
        handoffId,
        status: 'awaiting_recovery',
        phase: 'preparing',
        recoveryActions: ['restart_on_source', 'keep_stopped'],
      }),
      buildPrepareJobRecord: (input) => input as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: {
        acquire: async () => ({
          status: 'acquired',
          claim: {
            renew: vi.fn(async () => true),
            release: vi.fn(async () => undefined),
            record: { claimId: 'deferred-failure-claim' },
          },
        }),
      } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(async () => undefined),
    });

    const startedPromise = handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });
    await vi.advanceTimersByTimeAsync(751);
    await expect(startedPromise).resolves.toMatchObject({
      handoffId: 'handoff_deferred-failure',
      status: { status: 'pending' },
    });

    resolveStop('failed');
    await vi.waitFor(() => {
      expect(prepareJobStoreWrite).toHaveBeenCalledWith(expect.objectContaining({
        handoffId: 'handoff_deferred-failure',
        lastErrorCode: 'source_stop_failed',
      }));
    });
  });
});
