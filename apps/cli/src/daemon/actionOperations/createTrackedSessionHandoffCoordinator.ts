import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { HandoffWorkspaceActionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { HandoffTargetReplacementApprovalV1Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SpawnSessionExecutionAuthorizationSchema } from '@happier-dev/protocol/spawnSession';
import { resolveWorkspaceSyncEndpoint } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ActionExecuteResult, SessionHandoffPrepareTargetResponse, SessionHandoffStorageMode } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { prepareExternalActionHandoffContinuationAuthorization, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import { awaitSpawnedSessionId } from '@/session/services/awaitSpawnedSessionId';
import { buildMachineResumeRequest } from '@/session/services/requestInactiveSessionResume';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readProjectAccountRows, type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { resolveWorkspaceTransferRootWithScmWorkspace } from '@/scm/workspace';
import { getPathRemainderWithinBase, resolveSessionHandoffWorkspaceSessionPath } from '@/session/handoff/paths/sessionHandoffPathNormalization';

import type { ActionOperationOwnerUpdate } from './actionOperationTypes';
import { coordinateTrackedSessionHandoff } from './sessionHandoffCoordinator';
import { resolveSessionHandoffWorkspaceContext } from './sessionHandoffWorkspaceContext';
import { buildTrackedSessionHandoffMachineCall } from './trackedSessionHandoffMachineCall';
import { admitSessionHandoffExistingState, createSessionHandoffPreflightMachineRpc } from '@/session/handoff/sessionHandoffPreflightMachineRpc';
import type { WorkspaceSyncHandoffAdapter, PrepareWorkspaceSyncHandoffInput } from '@/workspaces/sync/workspaceSyncHandoffAdapter';

type SourceContext =
  | Readonly<{
      ok: true;
      sourceMachineId: string;
      sourceRootPath?: string;
      directoryKind?: 'path' | 'managed';
      sessionStorageMode: SessionHandoffStorageMode;
    }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type MachineCall = typeof callMachineRpc;

type CoordinatorDeps = Readonly<{
  /** Local profile scope for requester credentials and daemon lifetime. */
  expectedAccountServerId: string;
  /** Workspace semantic Home; materialization requires a fresh witness, membership can use the captured Home. */
  resolveWorkspaceAccountServerId?: (signal?: AbortSignal, options?: Readonly<{ requireFreshHome: boolean }>) => Promise<string | null>;
  readCredentials: () => Promise<StoredCredentials | null>;
  resolveSource?: (
    credentials: StoredCredentials,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SourceContext>;
  callMachine?: MachineCall;
  handoffAuthorization?: Readonly<{
    sourceExportStore: ReturnType<typeof createSessionHandoffSourceExportStore>;
    serverHttpBaseUrl: string;
    readSourceInstallation(): Readonly<{ machineId: string; installationId: string;
      privateKey: ExternalActionMachineRequestSigningKey }> | null;
  }>;
  awaitTargetCustody?: (input: Readonly<{
    credentials: StoredCredentials;
    machineId: string;
    sessionId: string;
    spawnNonce: string;
    spawnResult: unknown;
    signal: AbortSignal;
  }>) => Promise<Readonly<{ type: 'success'; sessionId: string } | { type: 'error'; errorCode: string; errorMessage: string }>>;
  wait?: (signal: AbortSignal) => Promise<void>;
  workspaceSyncAdapter: WorkspaceSyncHandoffAdapter;
  /** Actual installed Machine socket; context stays host-private and is never an Action field. */
  callWorkspaceSourcePhase?: (input: Parameters<NonNullable<PrepareWorkspaceSyncHandoffInput['callWorkspaceSourcePhase']>>[0],
    context: RpcActionExecutorContext) => Promise<unknown>;
  resolveWorkspaceTransferRoot?: typeof resolveWorkspaceTransferRootWithScmWorkspace;
  refreshProjectSnapshot?: (input: Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    signal?: AbortSignal;
  }>) => Promise<ActiveProjectAccountRowsSnapshot>;
}>;

type HostCoordinatorInput = Readonly<{
  operationId: string;
  actionInput: unknown;
  start: (privateActionInput: unknown) => Promise<ActionExecuteResult>;
  signal: AbortSignal;
  publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
  /** Preserved by the accepted Action owner, never read from author input. */
  context?: RpcActionExecutorContext;
}>;

type PreparedHandoffTarget = SessionHandoffPrepareTargetResponse & Readonly<{
  resume: NonNullable<SessionHandoffPrepareTargetResponse['resume']> & Readonly<{
    agentTarget: NonNullable<NonNullable<SessionHandoffPrepareTargetResponse['resume']>['agentTarget']>;
  }>;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readWorkspaceFailure(error: unknown, fallback: string): ActionExecuteResult {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Readonly<Record<string, unknown>>
    : null;
  const errorCode = typeof record?.code === 'string' && record.code.trim()
    ? record.code.trim()
    : fallback;
  return {
    ok: false,
    errorCode,
    error: error instanceof Error && error.message.trim() ? error.message.trim() : errorCode,
  };
}

async function resolveSourceContext(
  credentials: StoredCredentials,
  sessionId: string,
  signal: AbortSignal,
): Promise<SourceContext> {
  const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId, signal });
  if (!transport.ok) {
    return { ok: false, errorCode: transport.code, error: transport.code };
  }
  return resolveSessionHandoffSourceAuthority({
    credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
}

async function waitForTargetCustody(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  sessionId: string;
  spawnNonce: string;
  spawnResult: unknown;
  signal: AbortSignal;
  callMachine: MachineCall;
}>): Promise<Readonly<{ type: 'success'; sessionId: string } | { type: 'error'; errorCode: string; errorMessage: string }>> {
  return await awaitSpawnedSessionId({
    result: input.spawnResult,
    spawnNonce: input.spawnNonce,
    resolveSpawnSessionByNonce: async (spawnNonce, timeoutMs, observation) => normalizeSpawnSessionNonceResolution(
      await input.callMachine({
        credentials: input.credentials,
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
        request: { spawnNonce, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        timeoutMs: null,
        reattachOnReconnect: {
          readRequest: () => ({ spawnNonce,
            timeoutMs: observation?.readRemainingTimeoutMs() ?? timeoutMs }),
        },
        signal: observation?.signal ?? input.signal,
      }),
    ),
    signal: input.signal,
  });
}

export function buildTrackedSessionHandoffSpawnOptions(params: Readonly<{
  targetMachineId: string;
  prepared: PreparedHandoffTarget;
  stateTransfer?: 'transfer' | 'existing';
}>): SpawnSessionOptions {
  const prepared = params.prepared;
  const runtimeDescriptorV1 = readRuntimeDescriptorV1(prepared.runtimeDescriptorV1) ?? undefined;
  if (runtimeDescriptorV1 && runtimeDescriptorV1.agentId !== prepared.resume.agent) {
    throw new Error('Runtime descriptor Agent identity must match handoff resume Agent');
  }
  const agentTarget = AgentExecutionTargetV1Schema.parse(prepared.resume.agentTarget);
  return {
    machineId: params.targetMachineId,
    directory: prepared.resume.directory,
    ...(prepared.resume.directoryKind === 'managed' ? { directoryKind: 'managed' as const } : {}),
    agentTarget,
    resume: prepared.resume.resume,
    attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
    transcriptStorage: prepared.resume.transcriptStorage,
    ...(params.stateTransfer === 'existing' ? { handoffStateTransfer: 'existing' as const } : {}),
    executionAuthorization: SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: prepared.handoffId,
    }),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(prepared.resume.environmentVariables
      ? { environmentVariables: prepared.resume.environmentVariables }
      : {}),
  };
}

export function createTrackedSessionHandoffCoordinator(deps: CoordinatorDeps) {
  const resolveSource = deps.resolveSource ?? resolveSourceContext;
  const callMachine: MachineCall = deps.callMachine ?? (async (input) => await callMachineRpc(input));
  const preflightMachineRpc = createSessionHandoffPreflightMachineRpc({ callMachine, authorization: deps.handoffAuthorization });
  const refreshProjectSnapshot = deps.refreshProjectSnapshot ?? readProjectAccountRows;
  const resolveWorkspaceTransferRoot = deps.resolveWorkspaceTransferRoot ?? resolveWorkspaceTransferRootWithScmWorkspace;

  return async (hostInput: HostCoordinatorInput): Promise<ActionExecuteResult> => {
    const requester = hostInput.context?.requesterSessionBootstrap;
    const coordinate = async (): Promise<ActionExecuteResult> => {
    const rawInput = hostInput.actionInput && typeof hostInput.actionInput === 'object'
      && !Array.isArray(hostInput.actionInput)
      ? hostInput.actionInput as Readonly<Record<string, unknown>>
      : {};
    const sessionId = readNonEmptyString(rawInput.sessionId);
    const targetMachineId = readNonEmptyString(rawInput.targetMachineId);
    let targetPath = readNonEmptyString(rawInput.targetPath);
    const operationId = readNonEmptyString(hostInput.operationId);
    if (!operationId || !sessionId || !targetMachineId) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    if (rawInput.stateTransfer !== undefined && rawInput.stateTransfer !== 'transfer' && rawInput.stateTransfer !== 'existing') {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const stateTransfer = rawInput.stateTransfer;
    const admission = hostInput.context?.machineAdmission;
    if (requester && (requester.getBoundSessionId() !== sessionId
      || requester.attribution.serverId !== deps.expectedAccountServerId
      || admission && (requester.attribution.accountId !== admission.actorAccountId
        || requester.attribution.machineId !== admission.machineId
        || requester.attribution.installationId !== admission.installationId)
      || !await requester.isCurrent())) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    const credentials = requester?.credentials ?? await deps.readCredentials();
    if (!credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const source = await resolveSource(credentials, sessionId, hostInput.signal);
    if (!source.ok) return source;
    if (requester && (source.sourceMachineId !== requester.attribution.machineId || !await requester.isCurrent())) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    const managedTarget = source.directoryKind === 'managed';
    if (managedTarget) targetPath = null;
    const {
      sessionId: _untrustedSessionId,
      sourceMachineId: _untrustedSourceMachineId,
      targetMachineId: _untrustedTargetMachineId,
      sessionStorageMode: _untrustedSessionStorageMode,
      preferredTransportStrategies: _untrustedPreferredTransportStrategies,
      targetPath: _untrustedTargetPath,
      targetDirectory: _untrustedTargetDirectory,
      operationId: _untrustedOperationId,
      workspaceAction: _untrustedWorkspaceAction,
      stateTransfer: _untrustedStateTransfer,
      ...forwardedActionInput
    } = rawInput;
    const privateStartInput = {
      ...forwardedActionInput,
      sessionId,
      sourceMachineId: source.sourceMachineId,
      targetMachineId,
      sessionStorageMode: source.sessionStorageMode,
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'] as const,
      ...(managedTarget ? { operationId, targetDirectory: { kind: 'managed' as const } } : {}),
      ...(targetPath ? { targetPath } : {}),
      ...(stateTransfer ? { stateTransfer } : {}),
    };

    const parsedWorkspaceAction = managedTarget || rawInput.workspaceAction === undefined
      ? null
      : HandoffWorkspaceActionV1Schema.safeParse(rawInput.workspaceAction);
    if (parsedWorkspaceAction && !parsedWorkspaceAction.success) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const workspaceAction = parsedWorkspaceAction?.data;
    if (workspaceAction) Object.assign(privateStartInput, { workspaceAction });
    const parsedTargetReplacementApproval = rawInput.handoffTargetReplacementApproval === undefined
      ? null
      : HandoffTargetReplacementApprovalV1Schema.safeParse(rawInput.handoffTargetReplacementApproval);
    if (parsedTargetReplacementApproval && !parsedTargetReplacementApproval.success) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const targetReplacementApproval = parsedTargetReplacementApproval?.data;
    const targetReplacementApprovalReceiptId = readNonEmptyString(rawInput.handoffTargetReplacementApprovalReceiptId) ?? undefined;
    const targetReplacementApprovalActionInput = rawInput.handoffTargetReplacementApprovalActionInput;
    if ((targetReplacementApproval !== undefined) !== (targetReplacementApprovalReceiptId !== undefined)
      || (targetReplacementApproval !== undefined) !== (targetReplacementApprovalActionInput !== undefined)) {
      return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
    }
    const daemonMaterializesEndpoints = workspaceAction?.kind === 'create_relationship' || workspaceAction?.kind === 'copy_once';
    const daemonResolvesWorkspaceMembership = workspaceAction?.kind === 'relationship' || workspaceAction?.kind === 'linked_workspace';
    const accountServerId = readNonEmptyString(rawInput.accountServerId);
    let workspaceAccountServerId = deps.expectedAccountServerId.trim();
    if (daemonMaterializesEndpoints || daemonResolvesWorkspaceMembership) {
      try {
        hostInput.signal.throwIfAborted();
        const observedHome = deps.resolveWorkspaceAccountServerId
          ? await deps.resolveWorkspaceAccountServerId(hostInput.signal, { requireFreshHome: daemonMaterializesEndpoints }) : workspaceAccountServerId;
        hostInput.signal.throwIfAborted();
        if (!observedHome || (daemonMaterializesEndpoints || accountServerId !== null) && accountServerId !== observedHome.trim()) {
          return { ok: false, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
        }
        workspaceAccountServerId = observedHome.trim();
      } catch (error) {
        return readWorkspaceFailure(error, 'workspace_ref_not_ready');
      }
    }
    if (targetReplacementApproval && (
      !daemonMaterializesEndpoints
      || targetReplacementApproval.operationId !== operationId
      || targetReplacementApproval.serverId !== workspaceAccountServerId
      || targetReplacementApproval.machineId !== targetMachineId
    )) {
      return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
    }
    let workspaceContext: ReturnType<typeof resolveSessionHandoffWorkspaceContext> | undefined;
    let sessionRelativeCwd = '';
    let sourceWorkspaceRootPath = source.sourceRootPath;
    if (workspaceAction?.kind === 'relationship' || workspaceAction?.kind === 'linked_workspace') {
      try {
        // Endpoint identity is read from the authenticated Home's Project rows.
        const projectSnapshot = await refreshProjectSnapshot({
          credentials, serverId: workspaceAccountServerId, signal: hostInput.signal,
        });
        const sessionCwd = source.sourceRootPath;
        if (!sessionCwd) throw Object.assign(new Error('Source workspace path is unavailable'), { code: 'workspace_ref_not_ready' });
        const selectedRelationship = workspaceAction.kind === 'relationship'
          ? projectSnapshot.relationships.find((relationship) => relationship.relationshipId === workspaceAction.relationshipId)
          : undefined;
        const childMachines = await readWorkspaceSyncChildMachineFacts({
          serverId: workspaceAccountServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), credentials,
          machineIds: [source.sourceMachineId, targetMachineId], signal: hostInput.signal,
        });
        const sourceCandidates = projectSnapshot.workspaceRefs.filter((ref) => (
          ref.serverId.trim() === workspaceAccountServerId
          && ref.machineId === source.sourceMachineId
          && getPathRemainderWithinBase(sessionCwd, ref.rootPath) !== null
        )).filter((ref) => {
          const endpoint = resolveWorkspaceSyncEndpoint({ workspace: ref, workspaceRefs: projectSnapshot.workspaceRefs, childMachines });
          if (!endpoint.ok) throw Object.assign(new Error('Child workspace Sync endpoint is unavailable'), { code: endpoint.code });
          return workspaceAction.kind !== 'relationship' || !selectedRelationship
            || endpoint.endpoint.id === selectedRelationship.alphaWorkspaceRefId || endpoint.endpoint.id === selectedRelationship.betaWorkspaceRefId;
        });
        if (sourceCandidates.length !== 1) {
          throw Object.assign(new Error('Source workspace is not uniquely identified'), { code: 'relationship_source_mismatch' });
        }
        sourceWorkspaceRootPath = sourceCandidates[0]!.rootPath;
        sessionRelativeCwd = getPathRemainderWithinBase(sessionCwd, sourceWorkspaceRootPath)!;
        workspaceContext = resolveSessionHandoffWorkspaceContext({
          serverId: workspaceAccountServerId,
          action: workspaceAction,
          workspaceRefs: projectSnapshot.workspaceRefs,
          relationships: projectSnapshot.relationships,
          childMachines,
          sourceMachineId: source.sourceMachineId,
          sourceRootPath: sourceWorkspaceRootPath,
          targetMachineId,
          ...(targetPath ? { targetRootPath: targetPath } : {}),
        });
        const sourceHasGitLink = workspaceContext.contentSelection === 'git_worktree';
        if (sourceHasGitLink) {
          const transferRoot = await resolveWorkspaceTransferRoot({ sessionCwd });
          if (!transferRoot || transferRoot.repositoryRoot !== sourceWorkspaceRootPath) {
            throw Object.assign(new Error('Git worktree selection is unavailable for the source'), { code: 'git_selection_unavailable' });
          }
        }
      } catch (error) {
        return readWorkspaceFailure(error, 'workspace_ref_not_ready');
      }
    }
    const directContentSelection = workspaceAction?.kind === 'copy_once' || workspaceAction?.kind === 'create_relationship'
      ? workspaceAction.contentPolicy.selection
      : undefined;
    if (directContentSelection === 'git_worktree' && source.sourceRootPath) {
      try {
        const transferRoot = await resolveWorkspaceTransferRoot({ sessionCwd: source.sourceRootPath });
        if (!transferRoot) throw Object.assign(new Error('Git worktree selection is unavailable'), { code: 'git_selection_unavailable' });
        sourceWorkspaceRootPath = transferRoot.repositoryRoot;
        sessionRelativeCwd = transferRoot.sessionRelativeCwd;
      } catch (error) {
        return readWorkspaceFailure(error, 'git_selection_unavailable');
      }
    }
    const workspaceTargetRootPath = workspaceContext?.targetRootPath ?? targetPath ?? undefined;
    let targetSessionPath = workspaceTargetRootPath;
    const preservesWorkspaceSessionPath = workspaceAction?.kind === 'relationship'
      || workspaceAction?.kind === 'linked_workspace'
      || directContentSelection === 'git_worktree';
    if (preservesWorkspaceSessionPath && workspaceTargetRootPath) {
      try {
        targetSessionPath = resolveSessionHandoffWorkspaceSessionPath({
          targetRoot: workspaceTargetRootPath,
          sessionRelativeCwd,
        });
      } catch (error) {
        return readWorkspaceFailure(error, 'workspace_root_unsafe');
      }
    }

    let spawnResult: unknown;
    let spawnNonce: string | null = null;
    let acceptedHandoffId: string | null = null;
    const workspaceHandoffMethods = new Set<string>([
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
    ]);
    const rpc = async (machineId: string, method: string, request: unknown, signal?: AbortSignal,
      observation?: Pick<Parameters<MachineCall>[0], 'timeoutMs' | 'reattachOnReconnect'>) => {
      if (requester && !await requester.isCurrent()) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      try {
        const root = hostInput.context?.externalActionExecutionAuthorization;
        let externalAction: Parameters<MachineCall>[0]['externalAction'];
        if (root) {
          const boundary = deps.handoffAuthorization;
          const phaseInput = request && typeof request === 'object'
            && Reflect.get(request, 'kind') === 'requester_session_handoff_bootstrap_v1' ? Reflect.get(request, 'input') : request;
          const requestHandoffId = phaseInput && typeof phaseInput === 'object' ? readNonEmptyString(Reflect.get(phaseInput, 'handoffId')) : null;
          const handoffId = requestHandoffId ?? acceptedHandoffId;
          const custody = handoffId && boundary ? await boundary.sourceExportStore.load(handoffId) : null;
          const signer = boundary?.readSourceInstallation();
          const admission = root.binding.handoffAdmission;
          const actionId = resolveMachineRpcExternalActionEffectV1(method, root.binding,
            { machineId, installationId: root.binding.handoffAdmission?.targetInstallationId ?? '' });
          if (!boundary || !handoffId || !signer || !admission || !actionId
            || custody?.acceptedHandoffAuthorization?.token !== root.token
            || custody.sessionId !== sessionId || custody.sourceMachineId !== source.sourceMachineId
            || custody.targetMachineId !== targetMachineId || admission.sessionId !== sessionId
            || admission.sourceMachineId !== source.sourceMachineId || admission.targetMachineId !== targetMachineId
            || signer.machineId !== admission.sourceMachineId || signer.installationId !== admission.sourceInstallationId) {
            return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
          }
          const childAuthorization = await prepareExternalActionHandoffContinuationAuthorization({ authorization: custody.acceptedHandoffAuthorization,
            handoffId, actionId, input: request, machineId, sourceMachineId: signer.machineId,
            sourceInstallationId: signer.installationId, privateKey: signer.privateKey, serverHttpBaseUrl: boundary.serverHttpBaseUrl,
            ...(credentials.encryption?.type === 'dataKey' ? { material: credentials.encryption } : {}), ...(signal ? { signal } : {}) });
          const authorization = childAuthorization && requester
            ? await requester.projectExternalActionAuthorization(childAuthorization,
                childAuthorization.binding.serverIdentityId, signal) : childAuthorization;
          const currentSigner = boundary.readSourceInstallation();
          if (!authorization || !currentSigner || currentSigner.machineId !== signer.machineId
            || currentSigner.installationId !== signer.installationId) {
            return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
          }
          acceptedHandoffId = handoffId;
          externalAction = { context: { ...hostInput.context!, authority: 'account_automation',
            defaultSessionMachineId: signer.machineId, externalActionTarget: authorization.binding.target,
            externalActionExecutionAuthorization: authorization }, effectActionId: actionId,
            installationId: signer.installationId, privateKey: signer.privateKey };
        }
        return await callMachine(buildTrackedSessionHandoffMachineCall({
          credentials,
          machineId,
          method,
          request,
          ...(externalAction ? { externalAction, authorityCeiling: 'account_automation' as const } : {}),
          ...(signal ? { signal } : {}),
          ...(observation ?? {}),
        }));
      } catch (error) {
        if (workspaceAction?.kind !== undefined && workspaceAction.kind !== 'none'
          && workspaceHandoffMethods.has(method)
          && (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error))) {
          return {
            ok: false,
            errorCode: 'workspace_sync_update_required',
            error: 'Workspace sync requires a newer daemon',
          };
        }
        throw error;
      }
    };

    return await coordinateTrackedSessionHandoff({
      input: {
        operationId,
        sessionId,
        targetMachineId,
        ...(managedTarget ? { targetDirectory: { kind: 'managed' as const } } : {}),
        ...(targetSessionPath ? { targetPath: targetSessionPath } : {}),
        ...(stateTransfer ? { stateTransfer } : {}),
        ...(preservesWorkspaceSessionPath && workspaceTargetRootPath
          ? { workspaceSyncTargetSessionRelativeCwd: sessionRelativeCwd }
          : {}),
        ...(rawInput.targetSessionStorageMode === 'direct' || rawInput.targetSessionStorageMode === 'persisted'
          ? { targetSessionStorageMode: rawInput.targetSessionStorageMode }
          : {}),
        ...(workspaceAction ? { workspaceAction } : {}),
        ...(daemonMaterializesEndpoints ? { accountServerId: workspaceAccountServerId } : {}),
        ...(targetReplacementApproval ? { targetReplacementApproval } : {}),
        ...(targetReplacementApprovalReceiptId ? {
          targetReplacementApprovalReceiptId,
          targetReplacementApprovalActionInput,
        } : {}),
        ...(workspaceContext ? {
          workspaceSyncSourceRootPath: workspaceContext.sourceRootPath,
          workspaceSyncTargetRootPath: workspaceContext.targetRootPath,
          workspaceSyncSourceWorkspaceRefId: workspaceContext.sourceWorkspaceRefId,
          workspaceSyncTargetWorkspaceRefId: workspaceContext.targetWorkspaceRefId,
        } : daemonMaterializesEndpoints ? {
          workspaceSyncSourceRootPath: sourceWorkspaceRootPath,
          ...(targetPath ? { workspaceSyncTargetRootPath: targetPath } : {}),
        } : {}),
      },
      signal: hostInput.signal,
      ...(deps.callWorkspaceSourcePhase && hostInput.context ? {
        callWorkspaceSourcePhase: descriptor => deps.callWorkspaceSourcePhase!(descriptor, hostInput.context!),
      } : {}),
      start: async () => await hostInput.start(privateStartInput),
      resolveSource: async () => source,
      checkExistingTarget: async (request, signal) => await admitSessionHandoffExistingState({
        credentials, request, context: hostInput.context, rpc: preflightMachineRpc, signal,
      }) ?? { ok: true },
      prepareTarget: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
        requester || hostInput.context?.externalActionExecutionAuthorization ? {
          kind: 'requester_session_handoff_bootstrap_v1', input: { ...request, sessionId },
          requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials) },
        } : request,
        signal,
      ),
      getPreparedTargetResult: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
        request,
        signal,
      ),
      getTargetStatus: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
        request,
        signal,
      ),
      resumeTarget: async ({ sessionId: resumeSessionId, prepared }, signal) => {
        spawnNonce = createStableSpawnNonce('session.handoff.target', { handoffId: prepared.handoffId });
        const options = buildTrackedSessionHandoffSpawnOptions({
          targetMachineId,
          prepared: prepared as PreparedHandoffTarget,
          ...(stateTransfer ? { stateTransfer } : {}),
        });
        spawnResult = await rpc(
          targetMachineId,
          RPC_METHODS.SPAWN_HAPPY_SESSION,
          buildMachineResumeRequest(options, resumeSessionId, spawnNonce),
          signal,
        );
        const record = spawnResult && typeof spawnResult === 'object'
          ? spawnResult as Readonly<Record<string, unknown>>
          : null;
        return record?.type === 'success'
          ? { ok: true }
          : {
              ok: false,
              errorCode: readNonEmptyString(record?.errorCode) ?? 'session_handoff_resume_failed',
              error: readNonEmptyString(record?.errorMessage) ?? 'session_handoff_resume_failed',
            };
      },
      confirmTarget: async ({ sessionId: expectedSessionId }, signal) => {
        if (!spawnNonce) {
          return { ok: false, errorCode: 'session_handoff_target_unconfirmed', error: 'session_handoff_target_unconfirmed' };
        }
        const custodyInput = {
          credentials,
          machineId: targetMachineId,
          sessionId: expectedSessionId,
          spawnNonce,
          spawnResult,
          signal,
        };
        const settled = deps.awaitTargetCustody ? await deps.awaitTargetCustody(custodyInput)
          : await waitForTargetCustody({ ...custodyInput, callMachine: async input => await rpc(input.machineId,
              input.method, input.request, input.signal, { timeoutMs: input.timeoutMs,
                reattachOnReconnect: input.reattachOnReconnect }) });
        return settled.type === 'success' && settled.sessionId === expectedSessionId
          ? { ok: true }
          : {
              ok: false,
              errorCode: settled.type === 'error' ? settled.errorCode : 'session_handoff_target_unconfirmed',
              error: settled.type === 'error' ? settled.errorMessage : 'session_handoff_target_unconfirmed',
            };
      },
      commitTarget: async ({ machineId, ...request }, signal) => await rpc(
        machineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
        request,
        signal,
      ),
      cleanupSource: async ({ machineId, ...request }, signal) => await rpc(
        machineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
        request,
        signal,
      ),
      abort: async ({ machineId, ...request }) => {
        return await rpc(machineId, RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3, request);
      },
      publishOwnerUpdate: hostInput.publishOwnerUpdate,
      workspaceSyncAdapter: deps.workspaceSyncAdapter,
      ...(deps.wait ? { wait: deps.wait } : {}),
    });
    };
    return requester ? await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, coordinate) : await coordinate();
  };
}
