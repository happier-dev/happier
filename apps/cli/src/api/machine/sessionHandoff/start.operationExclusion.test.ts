import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

import { createExternalSessionOperationExclusion, type ExternalSessionOperationClaim } from '@/session/external/operationExclusion';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { buildPrepareJobRecord, buildStartPendingStatus, buildStartRecoveryStatus, invalidRequest } from './prepareTargetState';
import { createSessionHandoffStartActionHandler } from './start';


const enabledServerFeaturesSnapshot = {
  status: 'ready' as const,
  features: FeaturesResponseSchema.parse({
    features: {
      sessions: { enabled: true, handoff: { enabled: true } },
      machines: {
        enabled: true,
        transfer: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: true },
        },
      },
    },
    capabilities: {},
  }),
};

describe('session handoff start operation exclusion', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases its process claim when source publication fails before Stop', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-source-publication-failure-'));
    const owner = createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'source-publication-test' });
    const sessionId = `c${'a'.repeat(24)}`;
    let retained: ExternalSessionOperationClaim | undefined;
    const stop = vi.fn(async () => 'stopped' as const);
    try {
      // A real filesystem obstruction makes the durable source publisher fail.
      await writeFile(join(activeServerDir, 'session-handoff'), 'not a directory');
      const handler = createSessionHandoffStartActionHandler({ activeServerDir, createUuid: () => 'source-publication',
        loadSessionMetadata: async () => ({ path: '/source' }), machineTransferChannelPresent: true,
        directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined },
        resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot, stopSessionForHandoff: stop,
        sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
        prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }),
        prepareStartedState: async () => { throw new Error('Source publication must settle before preparation'); },
        exportSessionBundle: async () => { throw new Error('Source publication must settle before export'); },
        buildPrepareJobRecord, buildStartPendingStatus, buildStartRecoveryStatus, invalidRequest,
        sessionOperationExclusion: owner, retainSessionOperationClaim: (_id, claim) => { retained = claim; },
        releaseSessionOperationClaim: async () => { await retained?.release(); },
      });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
        machineId: 'source', custodianAccountId: 'owner', installationId: 'source-installation',
        actionId: 'session.handoff', requestId: 'source-publication', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'session', sessionId }, handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } });
      await expect(handler({ sessionId, sourceMachineId: 'source', targetMachineId: 'target',
        sessionStorageMode: 'persisted', preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        negotiatedTransportStrategy: 'direct_peer' }, { signal: new AbortController().signal, callerInputAuthorization: authorization })).rejects.toThrow();
      expect(stop).not.toHaveBeenCalled();
      const next = await owner.acquire({ kind: 'materialize', sessionId, requestId: 'next', sourceIdentity: 'source', sourceGeneration: 'one' });
      expect(next.status).toBe('acquired');
      if (next.status === 'acquired') await next.claim.release();
    } finally { await retained?.release(); await rm(activeServerDir, { recursive: true, force: true }); }
  });

  it('replaces an unavailable negotiated transport with the first available preference before source preparation', async () => {
    const prepareStartedState = vi.fn(async ({ handoffId, request }: {
      handoffId: string;
      request: { negotiatedTransportStrategy?: 'direct_peer' | 'server_routed_stream' };
    }) => ({
      nextState: {
        status: {
          handoffId,
          status: 'pending' as const,
          phase: 'preparing' as const,
          transportStrategy: request.negotiatedTransportStrategy,
          recoveryActions: [],
        },
      },
      endpointCandidates: [],
      targetPath: '/tmp/project',
    }));
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-transport-negotiation-test',
      createUuid: () => 'transport-negotiation',
      loadSessionMetadata: async () => ({ path: '/tmp/project' }),
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
      stopSessionForHandoff: vi.fn(async () => 'already_inactive' as const),
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: {
        acquire: vi.fn(async () => ({
          status: 'acquired' as const,
          claim: {
            release: vi.fn(async () => undefined),
            record: { claimId: 'transport-negotiation-claim' },
          },
        })),
      } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(async () => undefined),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toMatchObject({
      status: { transportStrategy: 'server_routed_stream' },
    });
    expect(prepareStartedState).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        negotiatedTransportStrategy: 'server_routed_stream',
      }),
    }));
  });

  it('returns transport_unavailable before metadata, claim, stop, or prepare when no preferred transport is available', async () => {
    const loadSessionMetadata = vi.fn(async () => ({ path: '/tmp/project' }));
    const acquire = vi.fn();
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const prepareStartedState = vi.fn();
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-transport-unavailable-test',
      createUuid: () => 'transport-unavailable',
      loadSessionMetadata,
      machineTransferChannelPresent: false,
      directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: { acquire } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(async () => undefined),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'transport_unavailable',
      error: 'transport_unavailable',
    });
    expect(loadSessionMetadata).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(prepareStartedState).not.toHaveBeenCalled();
  });

  it('cancels transport wait behind passive repair without starting handoff effects after release', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-start-barrier-cancel-'));
    const sessionOperationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'handoff-start-barrier-cancel',

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
      resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
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
    let cancellationAssertionTimer: ReturnType<typeof setTimeout> | null = null;
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
      resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: vi.fn() as never,
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

  it('rejects handoff before source metadata when the daemon snapshot disables session handoff', async () => {
    const loadSessionMetadata = vi.fn(async () => ({ path: '/tmp/project' }));
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const acquire = vi.fn();
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-server-policy-test',
      createUuid: () => 'server-policy',
      loadSessionMetadata,
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true, handoff: { enabled: false } },
            machines: {
              enabled: true,
              transfer: {
                enabled: true,
                directPeer: { enabled: true },
                serverRouted: { enabled: true },
              },
            },
          },
          capabilities: {},
        }),
      })),
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: vi.fn() as never,
      exportSessionBundle: vi.fn() as never,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: { acquire } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(async () => undefined),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'handoff_disabled',
      error: 'Session handoff is disabled on the selected server',
    });
    expect(loadSessionMetadata).not.toHaveBeenCalled();
    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects handoff before source metadata when machine transfer is disabled', async () => {
    const loadSessionMetadata = vi.fn(async () => ({ path: '/tmp/project' }));
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const acquire = vi.fn();
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-server-policy-test',
      createUuid: () => 'server-policy',
      loadSessionMetadata,
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: async () => ({
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true, handoff: { enabled: true } },
            machines: {
              enabled: true,
              transfer: {
                enabled: false,
                directPeer: { enabled: true },
                serverRouted: { enabled: true },
              },
            },
          },
          capabilities: {},
        }),
      }),
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() },
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: vi.fn() as never,
      exportSessionBundle: vi.fn() as never,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: { acquire } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(async () => undefined),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'transfer_disabled',
      error: 'Machine transfer is disabled on the selected server',
    });
    expect(loadSessionMetadata).not.toHaveBeenCalled();
    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
});
