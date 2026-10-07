import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { createDaemonPluginDevelopmentRootsOwner, type DaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { buildPrepareJobRecord, buildStartPendingStatus, buildStartRecoveryStatus, invalidRequest } from './prepareTargetState';
import { prepareStartedState } from './prepareStartedState';
import { deriveSessionCreationTagV1, FeaturesResponseSchema, SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createExternalSessionOperationExclusion, type ExternalSessionOperationClaimMaintenance } from '@/session/external/operationExclusion';
import { createSessionHandoffStartActionHandler } from './start';

describe('managed handoff source ownership', () => {
  let runtimeLease: PluginRuntimeRegistryLease | null = null;
  let developmentRootsOwner: DaemonPluginDevelopmentRootsOwner | null = null;
  beforeAll(async () => {
    // Use the daemon's real checkout-source custody owner for lazy SCM activation.
    const rootsOwner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: configuration.happyHomeDir,
      submitObservation: async () => {
        throw new Error('The managed handoff fixture does not observe development source changes');
      },
    });
    developmentRootsOwner = rootsOwner;
    runtimeLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
        pluginIds: [],
        resolveDevelopmentSourceAuthority: rootsOwner.resolveDevelopmentSourceAuthority,
      }),
    });
  });
  afterAll(async () => {
    try {
      await runtimeLease?.release();
      await pluginReloadController.shutdown();
    } finally {
      await developmentRootsOwner?.stop();
    }
  });
  it('recovers an unbound source from its validated persisted creation correspondence', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-source-unbound-'));
    try {
      const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'unbound-source' });
      const owner = createManagedSessionDirectories({ activeServerDir });
      const source = await owner.materializeForFreshSpawn({ sessionCreationTag });
      await writeFile(join(source.directory, 'notes.txt'), 'recoverable source');
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag, recipe: {
        execution: { machineId: 'a', directory: { kind: 'managed' } }, organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
        configuration: null, connectedServices: null, mcpSelection: null, transcriptStorage: null,
        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
      } });
      const result = await prepareStartedState({ activeServerDir,
        callInput: { handoffId: 'unbound_source', sourceStopState: 'already_inactive',
          request: { sessionId: 'session', operationId: 'operation', targetDirectory: { kind: 'managed' },
            sourceMachineId: 'a', targetMachineId: 'b', sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['server_routed_stream'], negotiatedTransportStrategy: 'server_routed_stream' },
          metadata: { path: source.directory, sessionDirectoryV1: { v: 1, kind: 'managed', futureField: 'ignored' },
            sessionCreationCorrespondenceV1: { ...correspondence, futureField: 'ignored' } },
        }, sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
        exportSessionBundle: async () => ({ targetPath: source.directory,
          agentBundle: { agentId: 'claude', remoteSessionId: 'native-source', transcriptBase64: 'e30K' } }), buildStartPendingStatus,
      });
      expect(result.nextState.handoffMetadataV2?.workspaceSeedTransferPublication).toBeDefined();
      expect((await owner.listRecords())[0]?.sessionId).toBe('session');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it('refuses to export managed workspace files without a source allocation record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-source-proof-'));
    try {
      await expect(prepareStartedState({
        activeServerDir,
        callInput: { handoffId: 'unproven_managed_source', sourceStopState: 'already_inactive',
          request: { sessionId: 'session', operationId: 'operation', targetDirectory: { kind: 'managed' },
            sourceMachineId: 'a', targetMachineId: 'b', sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['server_routed_stream'], negotiatedTransportStrategy: 'server_routed_stream',
          }, metadata: { path: '/unproven/source/path', sessionDirectoryV1: { v: 1, kind: 'managed' } },
        },
        sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
        exportSessionBundle: async () => ({ targetPath: '/unproven/source/path',
          agentBundle: { agentId: 'claude', remoteSessionId: 'native-source', transcriptBase64: 'e30K' },
        }), buildStartPendingStatus,
      })).rejects.toMatchObject({ code: 'SESSION_DIRECTORY_MISSING' });
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      let retainedClaim: ExternalSessionOperationClaimMaintenance | null = null;
      const handler = createSessionHandoffStartActionHandler({ activeServerDir, createUuid: () => 'missing_managed_source',
        loadSessionMetadata: async () => ({ path: '/unproven/source/path', sessionDirectoryV1: { v: 1, kind: 'managed' } }),
        machineTransferChannelPresent: true, directPeerTransfer: undefined,
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: { enabled: true, transfer: { enabled: true, serverRouted: { enabled: true } } },
        }, capabilities: {} }) }), stopSessionForHandoff: async () => 'already_inactive',
        prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }), sourceExportStore,
        prepareStartedState: (callInput) => prepareStartedState({ activeServerDir, callInput, sourceExportStore,
          exportSessionBundle: async () => ({ targetPath: '/unproven/source/path', agentBundle: {
            agentId: 'claude', remoteSessionId: 'native-source', transcriptBase64: 'e30K' } }), buildStartPendingStatus,
        }), exportSessionBundle: async () => { throw new Error('Source ownership must be established before native export'); },
        waitForPersistedSourceExport: async (handoffId) => sourceExportStore.load(handoffId),
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined,
        buildStartPendingStatus, buildStartRecoveryStatus, buildPrepareJobRecord, invalidRequest,
        sessionOperationExclusion: createExternalSessionOperationExclusion({ activeServerDir, ownerId: 'managed-source-test' }),
        retainSessionOperationClaim: (_handoffId, maintenance) => { retainedClaim = maintenance; },
        releaseSessionOperationClaim: async () => { retainedClaim?.stop(); await retainedClaim?.claim.release(); },
      });
      expect(await handler({ sessionId: 'session', operationId: 'operation', targetDirectory: { kind: 'managed' },
        sourceMachineId: 'a', targetMachineId: 'b', sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'], negotiatedTransportStrategy: 'server_routed_stream',
      })).toMatchObject({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
