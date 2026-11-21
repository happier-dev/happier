import { randomUUID } from 'node:crypto';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { RuntimeDescriptorV1, SessionHandoffResumePlan, SessionHandoffStatus } from '@happier-dev/protocol';
import {
  registerServerRoutedTransferResponder,
  type MachineTransferChannel,
} from '../../../machines/transfer/serverRoutedTransport';
import {
  createFileTransferPayloadSource,
} from '../../../machines/transfer/transferPayloadSource';
import {
  exportSessionHandoffState,
} from '../../../session/handoff/exportSessionHandoffState';
import { importSessionHandoffAgentBundle, resolveExistingSessionHandoffState } from '../../../session/handoff/agentBundle/import';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { resolveSessionSpawnIsolation } from '@/session/creation/resolveSessionSpawnManagedDefaults';
import { requiresRequesterWorkspaceCapture } from '../machineRpcAuthorization';
import { SessionHandoffExistingStateCheckRequestV3Schema, type SessionHandoffExistingStateCheckRequestV3 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { SessionHandoffWorkspaceCaptureRequestV3Schema, SessionHandoffWorkspaceCaptureResultV3Schema,
  type SessionHandoffWorkspaceCaptureRequestV3, type SessionHandoffWorkspaceCaptureResultV3 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import {
  resolveSessionHandoffExportMetadata,
  type SessionHandoffLocalMetadataSource,
} from '../../../session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  parseSessionHandoffAgentBundleTransferId,
  parseSessionHandoffWorkspaceSeedTransferId,
} from '../../../session/handoff/agentBundle/transferPublication';
import {
  createSessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  createSessionLifecycleRpcActionExecutor,
  registerSessionLifecycleRpcHandlers,
  withSessionHandoffRequesterBootstrap,
  SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
} from '@/rpc/handlers/sessionLifecycle';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import {
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import { createSessionHandoffStartActionHandler } from './start';
import { prepareSessionHandoffAgentBundleExport } from '@/session/handoff/agentBundle/export';
import {
  prepareStartedState as prepareStartedStateCore,
  type PrepareStartedStateCallInput,
} from './prepareStartedState';
import { createSessionHandoffPrepareTargetActionHandler } from './prepareTarget';
import { createSessionHandoffCommitActionHandler } from './commit';
import { createSessionHandoffAbortActionHandler } from './abort';
import { createSessionHandoffStatusGetActionHandler } from './statusGet';
import { createSessionHandoffPrepareTargetResultGetActionHandler } from './prepareTargetResultGet';
import { createSessionHandoffPrepareTargetResumeActionHandler } from './prepareTargetResume';
import {
  buildPrepareJobRecord,
  buildStartPendingStatus,
  buildStartRecoveryStatus,
  buildSourceExportOnlyPrepareJobId,
  invalidRequest,
  isTerminalHandoffStatus,
  readPersistedPrepareJob,
} from './prepareTargetState';
import {
  readSessionHandoffRuntimeConfig,
  type SessionHandoffRuntimeConfig,
} from './runtimeConfig';
import {
  UNSUPPORTED_SESSION_HANDOFF_RPC_METHODS,
  registerUnsupportedSessionHandoffRpcHandlers,
} from './unsupportedVersions';
import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationClaim,
  type ExternalSessionOperationExclusionOwner,
} from '@/session/external/operationExclusion';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '../../../session/shared/spawnSessionContract';
import type { RegisterActionSpecRpcHandlersParams } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { isRequesterSessionLifecycleCurrent } from '@/session/actions/lifecycle/requesterSessionLifecycle';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Default Home read shared by the handoff registrar and its source-admission boundary. */
export async function loadSessionHandoffRemoteMetadata(sessionId: string, context?: RpcHandlerContext): Promise<Record<string, unknown> | null> {
  if (!await isRequesterSessionLifecycleCurrent(sessionId, context)) return null;
  const read = async () => {
  const [{ readStoredCredentials }, { fetchSessionById }, { tryDecryptSessionOwnerMetadataView },
    { fetchAccountEncryptionCurrentness }] = await Promise.all([
      import('../../../persistence'), import('@/session/transport/http/sessionsHttp'),
      import('@/session/transport/encryption/sessionEncryptionContext'), import('@/api/client/connectedServiceCredentialApi'),
    ]);
  const credentials = context?.requesterSessionBootstrap?.credentials ?? await readStoredCredentials().catch(() => null);
  if (!credentials) return null;
  const [rawSession, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionById({ reason: 'session-control', token: credentials.token, sessionId, ...(context?.signal ? { signal: context.signal } : {}) }).catch(() => null),
    fetchAccountEncryptionCurrentness({ credentials: credentials, token: credentials.token, ...(context?.signal ? { signal: context.signal } : {}) }).catch(() => null),
  ]);
  if (!rawSession || !accountEncryptionCurrentness || !await isRequesterSessionLifecycleCurrent(sessionId, context)) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials, rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode });
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
  };
  return context?.requesterSessionBootstrap ? await runWithServerHttpBaseUrl(context.requesterSessionBootstrap.serverHttpBaseUrl, read) : await read();
}

export type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffExportBundleResult = Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
}>;

export type SessionHandoffRuntimeDependencies = Readonly<{
  createUuid: () => string;
  exportSessionHandoffState: typeof exportSessionHandoffState;
}>;

export function registerMachineSessionHandoffRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  localMachineId?: string;
  readHandoffTargetMachineMetadata?: () => MachineMetadataFieldReadV1;
  prepareManagedDirectoryPlacement?: Parameters<typeof createSessionHandoffPrepareTargetActionHandler>[0]['prepareManagedDirectoryPlacement'];
  prepareMemberImport?: Parameters<typeof createSessionHandoffPrepareTargetActionHandler>[0]['prepareMemberImport'];
  requesterSessionRuntime?: NonNullable<Parameters<typeof registerSessionLifecycleRpcHandlers>[0]['requesterSessionRuntime']>;
  requesterBootstrapBoundary?: NonNullable<Parameters<typeof registerSessionLifecycleRpcHandlers>[0]['requesterBootstrapBoundary']>;
  sessionOperationExclusion?: ExternalSessionOperationExclusionOwner;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  loadSessionMetadata?: (sessionId: string, context?: RpcHandlerContext) => Promise<Record<string, unknown> | null>;
  admitExistingSessionState?: (peerMachineId: string, context?: RpcHandlerContext, checkRequest?: SessionHandoffExistingStateCheckRequestV3) => Promise<Readonly<{ ok: false; errorCode: string; error?: string }> | null>;
  /** Workspace Sync's handoff TARGET capture owner. */
  captureWorkspace?: (request: SessionHandoffWorkspaceCaptureRequestV3, context: RpcHandlerContext) => Promise<SessionHandoffWorkspaceCaptureResultV3>;
  stopSessionForHandoff?: (sessionId: string, options?: Readonly<{ expectedSpawnNonce: string }>) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  spawnSessionForHandoff?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  exportSessionBundle?: (metadata: Record<string, unknown>) => Promise<Readonly<{
    agentBundle: SessionHandoffAgentBundle;
    targetPath: string;
  }>>;
  importSessionBundle?: (bundle: SessionHandoffAgentBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  runtimeConfig?: SessionHandoffRuntimeConfig;
  runtimeDependencies?: Partial<SessionHandoffRuntimeDependencies>;
  observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
  coordinateSessionHandoff?: (input: Readonly<{
    operationId: string;
    actionInput: unknown;
    start: (privateActionInput: unknown) => Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
    signal: AbortSignal;
    publishOwnerUpdate: (update: import('@/daemon/actionOperations').ActionOperationOwnerUpdate) => void;
    localPreparation?: Readonly<{
      machineId: string;
      waitForChange: (status: SessionHandoffStatus, signal: AbortSignal) => Promise<void>;
    }>;
    context?: import('@/rpc/handlers/_actionDispatchAdapter').RpcActionExecutorContext;
  }>) => Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
}>): void {
  const runtimeConfig = params.runtimeConfig ?? readSessionHandoffRuntimeConfig();
  const existingStateSupported = Boolean(params.admitExistingSessionState && params.requesterBootstrapBoundary);
  const createUuid = params.runtimeDependencies?.createUuid ?? randomUUID;
  const exportHandoffState = params.runtimeDependencies?.exportSessionHandoffState ?? exportSessionHandoffState;
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: runtimeConfig.activeServerDir,
  });
  const sourceExportStore = createSessionHandoffSourceExportStore({
    activeServerDir: runtimeConfig.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${createUuid()}`;
  const sessionOperationExclusion = params.sessionOperationExclusion
    ?? createExternalSessionOperationExclusion({
      activeServerDir: runtimeConfig.activeServerDir,
      ownerId: `cli-daemon:${process.pid}:session-operations:${createUuid()}`,
    });
  const activeHandoffOperationClaims = new Map<string, Readonly<{
    claim: ExternalSessionOperationClaim;
  }>>();
  const retainSessionOperationClaim = (
    handoffId: string,
    claim: ExternalSessionOperationClaim,
  ): void => {
    activeHandoffOperationClaims.set(handoffId, { claim });
  };
  const releaseSessionOperationClaim = async (handoffId: string): Promise<void> => {
    const active = activeHandoffOperationClaims.get(handoffId);
    if (!active) return;
    activeHandoffOperationClaims.delete(handoffId);
    await active.claim.release().catch(() => undefined);
  };
  const { rpcHandlerManager } = params;
  const loadRemoteSessionMetadata =
    params.loadSessionMetadata ??
    loadSessionHandoffRemoteMetadata;
  const loadLocalSessionMetadata =
    params.loadLocalSessionMetadata ??
    (async (): Promise<SessionHandoffLocalMetadataSource | null> => null);
  const loadSessionMetadata = async (
    sessionId: string,
    sourceMachineId?: string,
    context?: RpcHandlerContext,
  ): Promise<Record<string, unknown> | null> => {
    if (!await isRequesterSessionLifecycleCurrent(sessionId, context)) return null;
    const [localMetadata, remoteMetadata] = await Promise.all([
      loadLocalSessionMetadata(sessionId),
      loadRemoteSessionMetadata(sessionId, context),
    ]);
    return resolveSessionHandoffExportMetadata({
      remoteMetadata,
      localMetadata,
      ...(sourceMachineId ? { preferredLocalExportMachineId: sourceMachineId } : {}),
    });
  };
  const exportSessionBundle: (metadata: Record<string, unknown>) => Promise<SessionHandoffExportBundleResult> =
    params.exportSessionBundle ??
    (async (metadata: Record<string, unknown>) => {
      return await exportHandoffState({
        metadata,
        activeServerDir: runtimeConfig.activeServerDir,
      });
    });
  const importSessionBundle =
    params.importSessionBundle ??
    (async (bundle: SessionHandoffAgentBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') =>
      await importSessionHandoffAgentBundle({
        bundle,
        targetPath,
        sessionStorageMode,
      }));
  const prepareStartedState = async (
    callInput: PrepareStartedStateCallInput,
  ) => {
    return await prepareStartedStateCore({
      activeServerDir: runtimeConfig.activeServerDir,
      callInput,
      exportSessionBundle,
      sourceExportStore,
      directPeerTransfer: params.directPeerTransfer,
      buildStartPendingStatus,
    });
  };

  const resolveExistingSessionState = async (request: SessionHandoffExistingStateCheckRequestV3, targetPath: string, context?: RpcHandlerContext) => {
    context?.signal.throwIfAborted();
    if (!existingStateSupported) {
      throw Object.assign(new Error('handoff_existing_state_update_required'), { code: 'handoff_existing_state_update_required' });
    }
    const metadata = await loadSessionMetadata(request.sessionId, request.sourceMachineId, context);
    if (!metadata) throw Object.assign(new Error('Session metadata is unavailable'), { code: 'session_not_found' });
    const authority = resolveLinkedExternalSessionAuthorityV1(metadata);
    if (!authority.ok) throw Object.assign(new Error(authority.reason), { code: authority.error });
    if (authority.transcriptStorage !== request.sourceSessionStorageMode) throw Object.assign(new Error('Source Session storage mode changed'), { code: 'session_storage_mode_mismatch' });
    const state = await resolveExistingSessionHandoffState({ metadata, targetPath, sessionStorageMode: request.targetSessionStorageMode ?? request.sourceSessionStorageMode });
    context?.signal.throwIfAborted();
    return state;
  };
  const checkExistingState = async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = SessionHandoffExistingStateCheckRequestV3Schema.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    if (!existingStateSupported) return { ok: false, errorCode: 'handoff_existing_state_update_required' } as const;
    try {
      await resolveExistingSessionState(parsed.data, parsed.data.targetPath, context);
      return { ok: true } as const;
    } catch (error) {
      context?.signal.throwIfAborted();
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'target_import_failed';
      return { ok: false, errorCode: code, error: error instanceof Error ? error.message : 'Existing native state could not be verified' } as const;
    }
  };
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3, async (raw: unknown, context?: RpcHandlerContext) =>
    // The custodian and Manage keep native placement: no requester bootstrap is admitted for them.
    context?.machineAdmission && !requiresRequesterWorkspaceCapture(context.machineAdmission)
      ? { ok: true, capture: 'not_required' } : await withSessionHandoffRequesterBootstrap({
    method: RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3, input: raw, context,
    boundary: params.requesterBootstrapBoundary, handler: async (input, capturedContext) => {
      const request = SessionHandoffWorkspaceCaptureRequestV3Schema.safeParse(input);
      if (!request.success || !capturedContext) return invalidRequest();
      if (!params.captureWorkspace) return { ok: false, errorCode: 'workspace_sync_unavailable', error: 'Workspace sync is unavailable' };
      try {
        return SessionHandoffWorkspaceCaptureResultV3Schema.parse(await params.captureWorkspace(request.data, capturedContext));
      } catch (error) {
        capturedContext.signal.throwIfAborted();
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'workspace_sync_prepare_failed';
        return { ok: false, errorCode: code, error: error instanceof Error && error.message ? error.message : code };
      }
    },
  }));
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3, async (raw: unknown, context?: RpcHandlerContext) => await withSessionHandoffRequesterBootstrap({
    method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3, input: raw, context,
    boundary: params.requesterBootstrapBoundary, handler: checkExistingState,
  }));

	  if (params.machineTransferChannel) {
	    registerServerRoutedTransferResponder({
	      machineTransferChannel: params.machineTransferChannel,
	      loadTransferPayloadSource: async (request) => {
	        const workspaceSeedTransfer = parseSessionHandoffWorkspaceSeedTransferId(request.transferId);
	        if (workspaceSeedTransfer) {
	          const persisted = await sourceExportStore.load(workspaceSeedTransfer.handoffId);
	          const files = persisted?.workspaceSeed?.files;
	          const file = files && Object.hasOwn(files, request.transferId) ? files[request.transferId] : undefined;
	          return file ? createFileTransferPayloadSource(file) : null;
	        }
	        const agentBundleTransfer = parseSessionHandoffAgentBundleTransferId(request.transferId);
	        if (!agentBundleTransfer) return null;
        const persisted = await sourceExportStore.load(agentBundleTransfer.handoffId);
        if (!persisted?.agentBundle) return null;
        return createFileTransferPayloadSource({
	          filePath: persisted.agentBundle.filePath,
	          sizeBytes: persisted.agentBundle.sizeBytes,
	          manifestHash: persisted.agentBundle.manifestHash,
	        });
	      },
	    });
	  }

  const startHandler = createSessionHandoffStartActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    createUuid,
    loadSessionMetadata,
    machineTransferChannelPresent: params.machineTransferChannel !== undefined,
    ...(params.admitExistingSessionState ? { admitExistingSessionState: params.admitExistingSessionState } : {}),
    directPeerTransfer: params.directPeerTransfer,
    ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
    stopSessionForHandoff: params.stopSessionForHandoff,
    prepareJobStore,
    sourceExportStore,
    prepareStartedState,
    exportSessionBundle,
    prepareSessionBundleExport: params.exportSessionBundle
      ? async metadata => async () => await exportSessionBundle(metadata)
      : async metadata => await prepareSessionHandoffAgentBundleExport({ metadata, activeServerDir: runtimeConfig.activeServerDir }),
    buildStartPendingStatus,
    buildStartRecoveryStatus,
    buildPrepareJobRecord,
    invalidRequest,
    sessionOperationExclusion,
    retainSessionOperationClaim,
    releaseSessionOperationClaim,
  });

  const {
    handle: prepareTargetHandler,
    resumePersistedPrepareTarget,
  } = createSessionHandoffPrepareTargetActionHandler({
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    runtimeConfig,
    machineTransferChannel: params.machineTransferChannel,
    directPeerTransfer: params.directPeerTransfer,
    importSessionBundle,
    existingStateSupported,
    ...(params.prepareManagedDirectoryPlacement ? { prepareManagedDirectoryPlacement: params.prepareManagedDirectoryPlacement } : {}),
    ...(params.prepareMemberImport ? { prepareMemberImport: params.prepareMemberImport } : {}),
    resolveExistingSessionState: async (request, targetPath, context) => {
      if (!request.sessionId) throw Object.assign(new Error('Existing Session identity is missing'), { code: 'invalid_request' });
      return resolveExistingSessionState({ ...request, sessionId: request.sessionId }, targetPath, context);
    },
  });

  const prepareTargetResumeHandler = createSessionHandoffPrepareTargetResumeActionHandler({
    prepareJobStore,
    resumePersistedPrepareTarget,
  });

  const commitActionHandler = createSessionHandoffCommitActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    prepareJobStore,
    sourceExportStore,
    directPeerTransfer: params.directPeerTransfer,
    stopSessionForHandoff: params.stopSessionForHandoff,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidRequest,
  });
  const commitHandler = async (raw: unknown): Promise<unknown> => {
    const result = await commitActionHandler(raw);
    const response = result && typeof result === 'object' ? result as Record<string, unknown> : null;
    const status = response?.status && typeof response.status === 'object'
      ? response.status as Record<string, unknown>
      : null;
    if (typeof response?.handoffId === 'string' && status?.status === 'completed') {
      await releaseSessionOperationClaim(response.handoffId);
    }
    return result;
  };

  const abortActionHandler = createSessionHandoffAbortActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    prepareJobStore,
    sourceExportStore,
    directPeerTransfer: params.directPeerTransfer,
    stopSessionForHandoff: params.stopSessionForHandoff,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidRequest,
  });
  const abortHandler = async (raw: unknown): Promise<unknown> => {
    const result = await abortActionHandler(raw);
    const response = result && typeof result === 'object' ? result as Record<string, unknown> : null;
    const status = response?.status && typeof response.status === 'object'
      ? response.status as Record<string, unknown>
      : null;
    if (typeof response?.handoffId === 'string' && status?.status === 'aborted') {
      await releaseSessionOperationClaim(response.handoffId);
    }
    return result;
  };

  const statusGetHandler = createSessionHandoffStatusGetActionHandler({
    prepareJobStore,
    sourceExportStore,
    readPersistedPrepareJob,
    buildStartPendingStatus,
    invalidRequest,
  });

  const prepareTargetResultGetHandler = createSessionHandoffPrepareTargetResultGetActionHandler({
    prepareJobStore,
    readPersistedPrepareJob,
    isTerminalHandoffStatus,
    invalidRequest,
  });

  const lifecycleExecutor = createSessionLifecycleRpcActionExecutor({
    'session.handoff': startHandler,
    'session.handoff.prepare_target': prepareTargetHandler,
    'session.handoff.prepare_target.resume': prepareTargetResumeHandler,
    'session.handoff.prepare_target_result.get': prepareTargetResultGetHandler,
    'session.handoff.commit': commitHandler,
    'session.handoff.abort': abortHandler,
    'session.handoff.status.get': statusGetHandler,
  });
  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager: {
      registerHandler(method, handler) {
        if (!UNSUPPORTED_SESSION_HANDOFF_RPC_METHODS.has(method)) {
          rpcHandlerManager.registerHandler(method, handler);
        }
      },
    },
    ...(params.requesterSessionRuntime ? { requesterSessionRuntime: params.requesterSessionRuntime } : {}),
    ...(params.requesterBootstrapBoundary ? { requesterBootstrapBoundary: { ...params.requesterBootstrapBoundary,
      retainHandoffRequesterCustody: async (request, bootstrap) => {
        // Called only after exact target admission and same-Session credential binding.
        if (bootstrap.getBoundSessionId() !== request.sessionId || bootstrap.attribution.machineId !== request.targetMachineId
          || !await bootstrap.isCurrent()) throw new Error('Requester handoff custody unavailable');
        await sourceExportStore.save({ handoffId: request.handoffId, sessionId: request.sessionId,
          sourceMachineId: request.sourceMachineId, targetMachineId: request.targetMachineId, exportedAtMs: Date.now(),
          requesterSessionCredentialBinding: { sessionId: request.sessionId, attribution: bootstrap.attribution } });
      },
    } } : {}),
    actionExecutor: params.coordinateSessionHandoff
      ? {
          execute: async (actionId, input, context) => {
            if (actionId !== 'session.handoff') {
              return await lifecycleExecutor.execute(actionId, input, context);
            }
            return await params.coordinateSessionHandoff!({
              operationId: typeof context?.actionRequestId === 'string' && context.actionRequestId.trim()
                ? context.actionRequestId.trim()
                : '',
              actionInput: input,
              ...(context ? { context } : {}),
              start: async (privateActionInput) => await lifecycleExecutor.execute(
                actionId,
                privateActionInput,
                context,
              ),
              signal: context?.signal ?? new AbortController().signal,
              ...(params.localMachineId ? { localPreparation: {
                machineId: params.localMachineId,
                waitForChange: async (status: SessionHandoffStatus, signal: AbortSignal) => {
                  const jobId = status.jobId ?? (await readPersistedPrepareJob({ handoffId: status.handoffId, jobStore: prepareJobStore }))?.jobId;
                  if (jobId) await prepareJobStore.waitForChange({ jobId, observedStatus: status, signal });
                },
              } } : {}),
              publishOwnerUpdate: (update) => {
                context?.operationOwnerUpdate?.update(update);
              },
            });
          },
        }
      : lifecycleExecutor,
    scopes: SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
    ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
  });

  registerUnsupportedSessionHandoffRpcHandlers(rpcHandlerManager);
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET, async (raw: unknown, context?: RpcHandlerContext) => {
    const empty = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0;
    const request = empty ? null : SessionHandoffExistingStateCheckRequestV3Schema.safeParse(raw);
    if (request && !request.success) return invalidRequest();
    const binding = context?.callerInputAuthorization?.binding;
    const admission = context?.machineAdmission;
    // Signed preflight binds both peers. Ordinary preflight uses the Home-stamped
    // custodian's admission to this Machine and reads only its own isolation policy.
    const handoff = binding?.handoffPreflight ? binding.handoffAdmission
      : !binding && request?.success && admission && admission.machineId === params.localMachineId
        && admission.actorAccountId === admission.custodianAccountId ? request.data : undefined;
    if (handoff && handoff.sourceMachineId !== handoff.targetMachineId && handoff.targetMachineId === params.localMachineId) {
      const unavailable = { ok: false, errorCode: 'target_unavailable', error: 'The receiving machine’s isolation policy is unavailable.' };
      const snapshot = params.readHandoffTargetMachineMetadata?.();
      if (snapshot?.status !== 'ready') return unavailable;
      try {
        if (resolveSessionSpawnIsolation({}, snapshot.metadata)?.choice.kind === 'sandbox') {
          return { ok: false, errorCode: 'handoff_target_requires_sandbox_preset',
            error: 'This machine runs new sessions in a sandbox. Hand off to a sandbox preset.' };
        }
      } catch {
        return unavailable;
      }
    }
    return {
      protocolVersion: 3,
      // The current handoff runner does not prove atomic launch acceptance or target cleanup.
      atomicTargetResume: false,
      targetCleanup: false,
      sameMachineHandoff: true,
      existingState: existingStateSupported,
    };
  });
}
