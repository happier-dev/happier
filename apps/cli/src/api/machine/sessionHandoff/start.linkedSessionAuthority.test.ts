import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import { prepareStartedState } from './prepareStartedState';
import { buildPrepareJobRecord, buildStartPendingStatus, buildStartRecoveryStatus, invalidRequest } from './prepareTargetState';

import { createSessionHandoffStartActionHandler } from './start';

/**
 * Storage authority belongs to the SOURCE daemon, and it has to be settled
 * before the source is touched.
 *
 * Every branch of the start handler stops the source runtime before the export
 * — and therefore before the eligibility owner ever sees the metadata — so a
 * Session whose link cannot be resolved used to be quiesced and stopped, and
 * only then failed. Worse, the caller stamped the same unresolved link as
 * `persisted`, so a successful run would have imported it into the wrong
 * storage on the target.
 */
const VALID_LINK = {
  v: 1 as const,
  agentId: 'codex',
  machineId: 'machine-source',
  remoteSessionId: 'remote-1',
  source: { kind: 'codexHome' as const, home: 'user' as const },
};

const UNRESOLVED_OWNER_METADATA = [
  [
    'a malformed canonical link',
    {
      path: '/tmp/project',
      machineId: 'machine-source',
      externalSessionV1: {
        ...VALID_LINK,
        followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
      },
    },
    'linked_session_invalid',
  ],
  [
    'dual rows requiring reconciliation',
    {
      path: '/tmp/project',
      machineId: 'machine-source',
      externalSessionV1: VALID_LINK,
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    },
    'linked_session_reconciliation_required',
  ],
] as const;


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

describe('session handoff start — source-derived transcript-storage authority', () => {
  it.each(['handoff_existing_state_update_required', 'existing_session_state_unavailable'] as const)('refuses existing-state handoff before any source effect (%s)', async (errorCode) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'existing-handoff-admission-'));
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
    await prepareJobStore.findByHandoffId('existing');
    await sourceExportStore.load('existing');
    const initialFiles = await readdir(activeServerDir);
    const stop = vi.fn(async () => 'stopped' as const);
    const exportSessionBundle = async () => { throw new Error('Unexpected native export'); };
    try {
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir, createUuid: () => 'existing',
      loadSessionMetadata: async () => ({ path: '/source', machineId: 'machine-source' }),
      machineTransferChannelPresent: true, directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
      ...(errorCode === 'existing_session_state_unavailable' ? { admitExistingSessionState: async () => ({ ok: false as const, errorCode }) } : {}),
      stopSessionForHandoff: stop, prepareJobStore, sourceExportStore,
      prepareStartedState: async callInput => await prepareStartedState({ activeServerDir, callInput,
        sourceExportStore, exportSessionBundle, directPeerTransfer: undefined, buildStartPendingStatus }),
      exportSessionBundle,
      waitForPersistedSourceExport: async () => null, invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
      buildStartPendingStatus, buildStartRecoveryStatus, buildPrepareJobRecord, invalidRequest,
      sessionOperationExclusion: createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'existing-admission-test' }),
      retainSessionOperationClaim: () => undefined, releaseSessionOperationClaim: async () => undefined,
    });
    await expect(handler({ sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      stateTransfer: 'existing', targetPath: '/target', sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'] })).resolves.toMatchObject({ ok: false, errorCode });
    expect(stop).not.toHaveBeenCalled();
    expect(await sourceExportStore.load('existing')).toBeNull();
    expect(await prepareJobStore.findByHandoffId('existing')).toBeNull();
    expect(await readdir(activeServerDir)).toEqual(initialFiles);
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it('refuses a valid but stale caller storage mode before any source effect', async () => {
    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
    const prepareStartedState = vi.fn();
    const exportSessionBundle = vi.fn();
    const acquire = vi.fn(async () => ({ status: 'unavailable' as const }));
    const invalidateDirectPeerRouteCacheForHandoffMachines = vi.fn();

    const handler = createSessionHandoffStartActionHandler({
      activeServerDir: '/tmp/happier-handoff-storage-authority',
      createUuid: () => 'handoff-storage-authority',
      loadSessionMetadata: async () => ({
        path: '/tmp/project',
        machineId: 'machine-source',
        externalSessionV1: VALID_LINK,
      }),
      machineTransferChannelPresent: true,
      directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
      stopSessionForHandoff,
      prepareJobStore: { write: vi.fn() } as never,
      sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
      prepareStartedState: prepareStartedState as never,
      exportSessionBundle: exportSessionBundle as never,
      waitForPersistedSourceExport: vi.fn() as never,
      invalidateDirectPeerRouteCacheForHandoffMachines,
      buildStartPendingStatus: vi.fn() as never,
      buildStartRecoveryStatus: vi.fn() as never,
      buildPrepareJobRecord: vi.fn() as never,
      invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
      sessionOperationExclusion: { acquire } as never,
      retainSessionOperationClaim: vi.fn(),
      releaseSessionOperationClaim: vi.fn(),
    });

    await expect(handler({
      sessionId: 'session-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      // The current linked Session is direct. A predecessor/direct RPC may
      // still carry a valid but stale persisted classification.
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_storage_mode_mismatch',
    });

    expect(invalidateDirectPeerRouteCacheForHandoffMachines).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(stopSessionForHandoff).not.toHaveBeenCalled();
    expect(prepareStartedState).not.toHaveBeenCalled();
    expect(exportSessionBundle).not.toHaveBeenCalled();
  });

  it.each(UNRESOLVED_OWNER_METADATA)(
    'refuses %s with zero source effect',
    async (_label, ownerMetadata, errorCode) => {
      const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
      const prepareStartedState = vi.fn();
      const exportSessionBundle = vi.fn();
      // A realistic non-acquired outcome, so removing the authority gate makes
      // the handler answer `session_operation_in_progress` rather than crash:
      // the failure then names the missing gate instead of a stub.
      const acquire = vi.fn(async () => ({ status: 'unavailable' as const }));
      const invalidateDirectPeerRouteCacheForHandoffMachines = vi.fn();

      const handler = createSessionHandoffStartActionHandler({
        activeServerDir: '/tmp/happier-handoff-authority',
        createUuid: () => 'handoff-authority',
        loadSessionMetadata: async () => ownerMetadata as Record<string, unknown>,
        machineTransferChannelPresent: true,
        directPeerTransfer: undefined,
        resolveServerFeaturesSnapshot: async () => enabledServerFeaturesSnapshot,
        stopSessionForHandoff,
        prepareJobStore: { write: vi.fn() } as never,
        sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
        prepareStartedState: prepareStartedState as never,
        exportSessionBundle: exportSessionBundle as never,
        waitForPersistedSourceExport: vi.fn() as never,
        invalidateDirectPeerRouteCacheForHandoffMachines,
        buildStartPendingStatus: vi.fn() as never,
        buildStartRecoveryStatus: vi.fn() as never,
        buildPrepareJobRecord: vi.fn() as never,
        invalidRequest: () => ({ ok: false, errorCode: 'invalid_request' }),
        sessionOperationExclusion: { acquire } as never,
        retainSessionOperationClaim: vi.fn(),
        releaseSessionOperationClaim: vi.fn(),
      } as never);

      await expect(handler({
        sessionId: 'session-1',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        // The caller's own claim is exactly the wrong one the collapsed read
        // produced; the source daemon must not carry it through.
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
      })).resolves.toMatchObject({ ok: false, errorCode });

      expect(stopSessionForHandoff).not.toHaveBeenCalled();
      expect(prepareStartedState).not.toHaveBeenCalled();
      expect(exportSessionBundle).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    },
  );
});
