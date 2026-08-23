import { describe, expect, it, vi } from 'vitest';

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

describe('session handoff start — source-derived transcript-storage authority', () => {
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
        stopSessionForHandoff,
        prepareJobStore: { write: vi.fn() } as never,
        sourceExportStore: { save: vi.fn(), writeAgentBundleFile: vi.fn() } as never,
        prepareStartedState: prepareStartedState as never,
        exportSessionBundle: exportSessionBundle as never,
        waitForPersistedSourceExport: vi.fn() as never,
        invalidateDirectPeerRouteCacheForHandoffMachines,
        resolveWorkspaceReplicationHandoffBackTargetRootPath: () => null,
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
