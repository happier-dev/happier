import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import { createSessionHandoffStartActionHandler } from './start';

describe('session handoff start operation exclusion', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels transport wait behind passive repair without starting handoff effects after release', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-start-barrier-cancel-'));
    const sessionOperationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'handoff-start-barrier-cancel',
      claimMutationLockAcquisitionTimeoutMs: 10_000,
    });
    let signalRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      signalRepairStarted = resolve;
    });
    let releaseRepair!: () => void;
    const repairRelease = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const repair = sessionOperationExclusion.withPassiveRepairClaimBarrier({
      sessionId: 'session-1',
      operationClaimId: 'passive-repair-claim',
    }, async () => {
      signalRepairStarted();
      await repairRelease;
    });
    await repairStarted;
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const prepareStartedState = vi.fn();
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir,
      createUuid: () => 'handoff-barrier-cancel',
      loadSessionMetadata: async () => ({ path: '/tmp/project' }),
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
      waitForPersistedSourceExport: vi.fn() as never,
      invalidateDirectPeerRouteCacheForHandoffMachines: vi.fn(),
      resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(),
    });
    const request = {
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    } as const;
    const controller = new AbortController();
    const result = handler(request, { signal: controller.signal });
    let cancellationAssertionTimer: NodeJS.Timeout | null = null;
    try {
      controller.abort();
      await expect(Promise.race([
        result.then(
          () => 'handoff_start_resolved',
          (error: unknown) => error instanceof Error ? error.name : 'unknown_error',
        ),
        new Promise((resolve) => {
          cancellationAssertionTimer = setTimeout(
            () => resolve('handoff_start_did_not_observe_cancellation'),
            500,
          );
        }),
      ])).resolves.toBe('AbortError');
      expect(stopSessionForHandoff).not.toHaveBeenCalled();
      expect(prepareStartedState).not.toHaveBeenCalled();
    } finally {
      if (cancellationAssertionTimer) {
        clearTimeout(cancellationAssertionTimer);
      }
      releaseRepair();
      await repair;
      await result.catch(() => undefined);
    }

    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(prepareStartedState).not.toHaveBeenCalled();
    const probe = await sessionOperationExclusion.acquire({
      kind: 'handoff',
      sessionId: request.sessionId,
      requestId: 'post-cancellation-probe',
      sourceMachineId: request.sourceMachineId,
      targetMachineId: request.targetMachineId,
      semanticRequest: 'post-cancellation-probe',
    });
    expect(probe.status).toBe('acquired');
    if (probe.status === 'acquired') await probe.claim.release();
    await rm(activeServerDir, { recursive: true, force: true });
  }, 3_000);

  it('fails before stop/export when takeover already owns the session operation', async () => {
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const prepareStartedState = vi.fn();
    const acquireOperation = vi.fn(async () => ({
      status: 'conflict' as const,
      reason: 'active_operation' as const,
      active: {
        request: { kind: 'takeover' as const },
      },
    }));
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-operation-exclusion-test',
      createUuid: () => 'handoff-operation-exclusion',
      loadSessionMetadata: async () => ({ path: '/tmp/project' }),
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
      waitForPersistedSourceExport: vi.fn() as never,
      invalidateDirectPeerRouteCacheForHandoffMachines: vi.fn(),
      resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: {
        acquire: acquireOperation,
      } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_operation_in_progress',
      error: 'Another session operation is already in progress',
    });
    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(prepareStartedState).not.toHaveBeenCalled();
    expect(acquireOperation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'handoff',
      semanticRequest: JSON.stringify({
        negotiatedTransportStrategy: 'server_routed_stream',
        preferredTransportStrategies: ['server_routed_stream'],
        sessionId: 'session-1',
        sessionStorageMode: 'persisted',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
      }),
    }));
  });

  it.each([
    ['lost ownership', async (): Promise<boolean> => false],
    ['renewal error', async (): Promise<boolean> => {
      throw new Error('claim storage unavailable');
    }],
  ] as const)(
    'stops active source work and persists awaiting_user_resume when renewal reports %s',
    async (_case, renew) => {
      vi.useFakeTimers();
      const prepareJobStoreWrite = vi.fn(async () => undefined);
      const stopSessionForHandoff = vi.fn(
        async () => await new Promise<'already_inactive'>((resolve) => {
          setTimeout(() => resolve('already_inactive'), 20_000);
        }),
      );
      const prepareStartedState = vi.fn(async () => ({
        nextState: {
          status: {
            handoffId: 'handoff_handoff-operation-claim-loss',
            status: 'pending' as const,
            phase: 'preparing' as const,
            recoveryActions: [],
          },
        },
        endpointCandidates: [],
        targetPath: '/tmp/project',
      }));
      const release = vi.fn(async () => undefined);
      const handler = createSessionHandoffStartActionHandler({
        activeServerDir: '/tmp/happier-handoff-operation-claim-loss-test',
        createUuid: () => 'handoff-operation-claim-loss',
        loadSessionMetadata: async () => ({ path: '/tmp/project' }),
        machineTransferChannelPresent: true,
        directPeerTransfer: undefined,
        stopSessionForHandoff,
        prepareJobStore: { write: prepareJobStoreWrite },
        sourceExportStore: {
          save: vi.fn(async () => undefined),
          writeAgentBundleFile: vi.fn(),
        } as never,
        prepareStartedState: prepareStartedState as never,
        exportSessionBundle: vi.fn() as never,
        waitForPersistedSourceExport: vi.fn() as never,
        invalidateDirectPeerRouteCacheForHandoffMachines: vi.fn(),
        resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
        buildStartPendingStatus: vi.fn() as never,
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
              renew: vi.fn(renew),
              release,
              record: { claimId: 'handoff-claim-1' },
            },
          }),
        } as never,
        retainSessionOperationClaim: vi.fn(),
        releaseSessionOperationClaim: vi.fn(async () => {
          await release();
        }),
      });

      const resultPromise = handler({
        sessionId: 'session-1',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
      });
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        errorCode: 'session_operation_claim_lost',
        handoffId: 'handoff_handoff-operation-claim-loss',
        status: {
          status: 'awaiting_user_resume',
        },
      });
      expect(prepareStartedState).not.toHaveBeenCalled();
      expect(prepareJobStoreWrite).toHaveBeenCalledWith(expect.objectContaining({
        handoffId: 'handoff_handoff-operation-claim-loss',
        status: expect.objectContaining({
          status: 'awaiting_user_resume',
        }),
      }));
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
