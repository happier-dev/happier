import { logger } from '@/ui/logger';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import { prepareStartedState } from './prepareStartedState';
import { buildPrepareJobRecord, buildStartPendingStatus, buildStartRecoveryStatus, invalidRequest } from './prepareTargetState';

import { createSessionHandoffStartActionHandler } from './start';
import { prepareSessionHandoffAgentBundleExport } from '@/session/handoff/agentBundle/export';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readSessionHandoffAgentBundleFile } from '@/session/handoff/agentBundle/file';
import { readSessionHandoffAgentBundleRecords } from '@/session/handoff/agentBundle/records';

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
  it.each([{ catchSite: 'preparation', native: true }, { catchSite: 'preparation', native: false }, { catchSite: 'export', native: true }, { catchSite: 'export', native: false }])('carries export exceptions from $catchSite (native=$native)', async ({ catchSite, native }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-source-cause-'));
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    try {
        // Stand-in only for the native Agent export boundary; orchestration and stores stay real.
        const exportSessionBundle = async () => { throw native
          ? new TypeError('Native export refused', { cause: Object.assign(new Error('read refused'), { code: 'EACCES' }) })
          : new Error('Native export failed'); };
        const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
        const handler = createSessionHandoffStartActionHandler({
          activeServerDir, createUuid: () => 'cause-test',
          loadSessionMetadata: async () => ({ path: activeServerDir, machineId: 'machine-source', externalSessionV1: VALID_LINK }),
          machineTransferChannelPresent: true, directPeerTransfer: undefined,
          resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
          stopSessionForHandoff: async () => 'stopped',
          prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }), sourceExportStore,
          ...(catchSite === 'preparation' ? { prepareSessionBundleExport: async () => {
            await exportSessionBundle(); return exportSessionBundle;
          } } : {}),
          prepareStartedState: async callInput => prepareStartedState({ activeServerDir, callInput,
            sourceExportStore, exportSessionBundle, directPeerTransfer: undefined, buildStartPendingStatus }),
          exportSessionBundle, buildStartPendingStatus, buildStartRecoveryStatus, buildPrepareJobRecord, invalidRequest,
          sessionOperationExclusion: createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'cause-test' }),
          retainSessionOperationClaim: () => undefined, releaseSessionOperationClaim: async () => undefined,
        });
        const result = await handler({ sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
          sessionStorageMode: 'direct', preferredTransportStrategies: ['server_routed_stream'] });
        expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
          error: native ? 'Native export refused' : 'Native export failed',
          failureCause: { phase: 'session_handoff.source_export', errorClass: native ? 'TypeError' : 'Error',
            errorCode: native ? 'EACCES' : null, httpStatus: null },
          ...(catchSite === 'preparation' ? { effectAttempted: false } : { status: { status: 'awaiting_recovery' } }),
        });
        expect(log).toHaveBeenCalledWith('[session-handoff] source_export_failed', expect.objectContaining({
          catch: catchSite, errorClass: native ? 'TypeError' : 'Error', errorCode: native ? 'EACCES' : null,
        }));
    } finally { log.mockRestore(); await rm(activeServerDir, { recursive: true, force: true }); }
  });

  it('retains the native export diagnostics when preparation refuses before Stop', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-early-export-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    try {
      const configDir = join(activeServerDir, 'claude');
      await mkdir(join(configDir, 'projects', 'source-project'), { recursive: true });
      const metadata = { machineId: 'machine-source', path: activeServerDir,
        externalSessionV1: { v: 1, agentId: 'claude', machineId: 'machine-source', remoteSessionId: 'native-claude',
          source: { kind: 'claudeConfig', configDir, projectId: 'source-project' } } };
      const exportSessionBundle = async () => await (await prepareSessionHandoffAgentBundleExport({ metadata, activeServerDir }))();
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      const stop = vi.fn(async () => 'stopped' as const);
      const handler = createSessionHandoffStartActionHandler({
        activeServerDir, createUuid: () => 'early-export', loadSessionMetadata: async () => metadata,
        machineTransferChannelPresent: true, directPeerTransfer: undefined,
        resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
        stopSessionForHandoff: stop,
        prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }), sourceExportStore,
        prepareSessionBundleExport: async () => {
          // Exercise the preparation catch with the real provider's sanitized refusal, not a copied diagnostic fixture.
          const prepared = await prepareSessionHandoffAgentBundleExport({ metadata, activeServerDir });
          await prepared();
          return prepared;
        },
        prepareStartedState: async callInput => await prepareStartedState({ activeServerDir, callInput,
          sourceExportStore, exportSessionBundle, directPeerTransfer: undefined, buildStartPendingStatus }),
        exportSessionBundle, buildStartPendingStatus, buildStartRecoveryStatus, buildPrepareJobRecord, invalidRequest,
        sessionOperationExclusion: createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'early-export' }),
        retainSessionOperationClaim: () => undefined, releaseSessionOperationClaim: async () => undefined,
      });
      const result = await handler({ sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
        sessionStorageMode: 'direct', preferredTransportStrategies: ['server_routed_stream'] });
      expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
        failureCause: { phase: 'session_handoff.source_export', errorCode: 'handoff_failed' },
        details: { diagnostics: [{ code: 'transcript_missing', details: { pathKind: 'transcript_file' } }] } });
      expect(stop).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(configDir);
    } finally { await runtime.dispose(); await rm(activeServerDir, { recursive: true, force: true }); }
  });

  it.each([
    { strategy: 'server_routed_stream', sameMachine: false, sameDirectory: false, missingTranscript: false },
    { strategy: 'direct_peer', sameMachine: false, sameDirectory: false, missingTranscript: false },
    { strategy: 'direct_peer', sameMachine: true, sameDirectory: false, missingTranscript: false },
    { strategy: 'direct_peer', sameMachine: true, sameDirectory: true, missingTranscript: false },
    { strategy: 'server_routed_stream', sameMachine: false, sameDirectory: false, missingTranscript: true },
  ] as const)('exports supported native source state once after its single stop ($strategy, sameMachine=$sameMachine, sameDirectory=$sameDirectory, missingTranscript=$missingTranscript)', async ({ strategy, sameMachine, sameDirectory, missingTranscript }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-supported-source-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const publishedTransfers: string[] = [];
    try {
      const configDir = join(activeServerDir, 'claude');
      const projectDir = join(configDir, 'projects', 'source-project');
      const workspaceDirectory = join(activeServerDir, 'workspace');
      await mkdir(workspaceDirectory);
      await mkdir(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, 'native-claude.jsonl');
      await writeFile(transcriptPath, '{"type":"assistant","text":"before_stop"}\n');
      const stop = vi.fn(async () => {
        if (missingTranscript) await rm(transcriptPath);
        else await writeFile(transcriptPath, '{"type":"assistant","text":"after_stop"}\n');
        return 'stopped' as const;
      });
      // Native transcript IO and all admission/export/storage owners remain real.
      const rpcHandlerManager = { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => handlers.set(method, handler) } as unknown as RpcHandlerManager;
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager, runtimeConfig: { activeServerDir }, runtimeDependencies: { createUuid: () => 'test' },
        loadSessionMetadata: async () => ({ machineId: 'machine-source', path: sameMachine ? 'relative/source' : '/source',
          ...(sameMachine ? { sessionWorkspaceLocationV1: { v: 1, machineId: 'machine-source',
            agentPath: 'relative/source', machinePath: workspaceDirectory } } : {}),
          externalSessionV1: { v: 1, agentId: 'claude', machineId: 'machine-source', remoteSessionId: 'native-claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'source-project' } } }),
        stopSessionForHandoff: stop, resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
        machineTransferChannel: { onEnvelope: () => () => undefined, sendEnvelope: () => undefined },
        ...(strategy === 'direct_peer' ? { directPeerTransfer: {
          publishTransfer: ({ transferId }: { transferId: string }) => { publishedTransfers.push(transferId); return []; },
          clearPublishedTransfer: () => undefined,
        } } : {}),
      });
      const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)!({
        sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: sameMachine ? 'machine-source' : 'machine-target',
        ...(sameMachine ? { targetPath: sameDirectory ? workspaceDirectory : join(activeServerDir, 'target') } : {}),
        sessionStorageMode: 'direct', preferredTransportStrategies: [strategy, 'server_routed_stream'],
        negotiatedTransportStrategy: strategy,
      });
      if (sameDirectory) {
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_target_path' });
        expect(stop).not.toHaveBeenCalled();
        return;
      }
      if (missingTranscript) {
        expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
          failureCause: { phase: 'session_handoff.source_export', errorClass: 'Error', errorCode: 'handoff_failed', httpStatus: null },
          details: { diagnostics: [{ code: 'transcript_missing', details: { pathKind: 'transcript_file' } }] },
          status: { status: 'awaiting_recovery', recoveryActions: ['restart_on_source', 'keep_stopped'] } });
        expect(JSON.stringify(result)).not.toContain(configDir);
        expect(JSON.stringify(result)).not.toContain('native-claude');
        expect(stop).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result).toMatchObject({ handoffId: 'handoff_test', status: { status: 'pending' } });
      if (strategy === 'direct_peer') expect(result).toMatchObject({ handoffMetadataV2: {
        agentBundleTransferPublication: { transferId: 'session-handoff:handoff_test:provider-bundle-file' },
      } });
      expect(stop).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => {
        expect((await createSessionHandoffSourceExportStore({ activeServerDir }).load('handoff_test'))?.agentBundle).toBeDefined();
      });
      const record = await createSessionHandoffSourceExportStore({ activeServerDir }).load('handoff_test');
      if (!record?.agentBundle) throw new Error('Source did not publish its native export');
      const bundle = await readSessionHandoffAgentBundleFile(record.agentBundle.filePath);
      expect(await readSessionHandoffAgentBundleRecords(bundle)).toEqual([{ type: 'assistant', text: 'after_stop' }]);
      expect(publishedTransfers.filter(transferId => transferId.endsWith(':deferred-carrier'))).toEqual([]);
    } finally {
      await handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3)?.({ handoffId: 'handoff_test' });
      await runtime.dispose();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
  it.each([
    { strategy: 'server_routed_stream', agent: 'muse' },
    { strategy: 'direct_peer', agent: 'gemini' },
  ] as const)('carries the $agent capability refusal over $strategy without stopping the source', async ({ strategy, agent }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-ineligible-source-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: [`happier.agent.${agent}`] } });
    try {
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      // Only RPC registration and the native process stop are external boundaries.
      const rpcHandlerManager = { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => handlers.set(method, handler) } as unknown as RpcHandlerManager;
      const stop = vi.fn(async () => 'stopped' as const);
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager, runtimeConfig: { activeServerDir }, runtimeDependencies: { createUuid: () => 'test' },
        loadSessionMetadata: async () => ({ machineId: 'machine-source', path: '/source', flavor: agent,
          nativeResumeIdentityV1: { v: 1, vendorResumeId: `native-${agent}` } }),
        stopSessionForHandoff: stop,
        resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
        machineTransferChannel: { onEnvelope: () => () => undefined, sendEnvelope: () => undefined },
        ...(strategy === 'direct_peer' ? { directPeerTransfer: {
          publishTransfer: () => [], clearPublishedTransfer: () => undefined,
        } } : {}),
      });
      const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)!({
        sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
        sessionStorageMode: 'persisted', preferredTransportStrategies: [strategy, 'server_routed_stream'],
        negotiatedTransportStrategy: strategy,
      });
      expect(stop).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, errorCode: 'handoff_unsupported', effectAttempted: false,
        failureCause: { phase: 'session_handoff.source_export', errorCode: 'handoff_unsupported' } });
      expect(await createSessionHandoffSourceExportStore({ activeServerDir }).load('handoff_test')).toBeNull();
    } finally { await runtime.dispose(); await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it.each(['handoff_existing_state_update_required', 'existing_session_state_unavailable'] as const)('refuses existing-state handoff before any source effect (%s)', async (errorCode) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'existing-handoff-admission-'));
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
    const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
    await prepareJobStore.findByHandoffId('existing');
    await sourceExportStore.load('existing');
    const initialFiles = await readdir(activeServerDir);
    const stop = vi.fn(async () => 'stopped' as const);
    const sameMachine = errorCode === 'existing_session_state_unavailable';
    const sourcePath = join(activeServerDir, 'source');
    const admitExistingSessionState: NonNullable<Parameters<typeof createSessionHandoffStartActionHandler>[0]['admitExistingSessionState']> =
      async (_machineId, _context, checkRequest) => {
        expect(checkRequest?.targetPath).toBe(sourcePath);
        return { ok: false, errorCode };
      };
    const exportSessionBundle = async () => { throw new Error('Unexpected native export'); };
    try {
    const handler = createSessionHandoffStartActionHandler({
      activeServerDir, createUuid: () => 'existing',
      loadSessionMetadata: async () => ({ path: sameMachine ? 'relative/source' : '/source', machineId: 'machine-source',
        ...(sameMachine ? { sessionWorkspaceLocationV1: { v: 1, machineId: 'machine-source',
          agentPath: 'relative/source', machinePath: sourcePath } } : {}),
      }),
      machineTransferChannelPresent: true, directPeerTransfer: undefined,
      resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
      ...(sameMachine ? { admitExistingSessionState } : {}),
      stopSessionForHandoff: stop, prepareJobStore, sourceExportStore,
      prepareStartedState: async callInput => await prepareStartedState({ activeServerDir, callInput,
        sourceExportStore, exportSessionBundle, directPeerTransfer: undefined, buildStartPendingStatus }),
      exportSessionBundle,
      buildStartPendingStatus, buildStartRecoveryStatus, buildPrepareJobRecord, invalidRequest,
      sessionOperationExclusion: createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'existing-admission-test' }),
      retainSessionOperationClaim: () => undefined, releaseSessionOperationClaim: async () => undefined,
    });
    await expect(handler({ sessionId: 'session', sourceMachineId: 'machine-source', targetMachineId: sameMachine ? 'machine-source' : 'machine-target',
      stateTransfer: 'existing', ...(sameMachine ? {} : { targetPath: '/target' }),
      sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'] })).resolves.toMatchObject({ ok: false, errorCode });
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
