import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { HandoffWorkspaceActionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { HandoffTargetReplacementApprovalV1Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SpawnSessionExecutionAuthorizationSchema } from '@happier-dev/protocol/spawnSession';
import type { ActionExecuteResult, SessionHandoffPrepareTargetResponse, SessionHandoffStorageMode, WorkspaceRefV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import { awaitSpawnedSessionId } from '@/session/services/awaitSpawnedSessionId';
import { buildMachineResumeRequest } from '@/session/services/requestInactiveSessionResume';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { resolveWorkspaceTransferRootWithScmWorkspace } from '@/scm/workspace';
import { getPathRemainderWithinBase, resolveSessionHandoffWorkspaceSessionPath } from '@/session/handoff/paths/sessionHandoffPathNormalization';

import type { ActionOperationOwnerUpdate } from './actionOperationTypes';
import { coordinateTrackedSessionHandoff } from './sessionHandoffCoordinator';
import { resolveSessionHandoffWorkspaceContext } from './sessionHandoffWorkspaceContext';
import { buildTrackedSessionHandoffMachineCall } from './trackedSessionHandoffMachineCall';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';

type SourceContext =
  | Readonly<{
      ok: true;
      sourceMachineId: string;
      sourceRootPath?: string;
      directoryKind?: 'path' | 'managed';
      sessionStorageMode: SessionHandoffStorageMode;
    }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type MachineCall = (input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: string;
  request: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}>) => Promise<unknown>;

type CoordinatorDeps = Readonly<{
  /** Daemon-host Account Home scope; caller payload may only prove it matches this owner. */
  expectedAccountServerId: string;
  readCredentials: () => Promise<StoredCredentials | null>;
  resolveSource?: (
    credentials: StoredCredentials,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SourceContext>;
  callMachine?: MachineCall;
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
  resolveWorkspaceTransferRoot?: typeof resolveWorkspaceTransferRootWithScmWorkspace;
  refreshWorkspaceSettings?: (input: Readonly<{
    credentials: StoredCredentials;
  }>) => Promise<Readonly<{
    settingsVersion: number;
    settings: Readonly<{
      workspaceRefsV1: readonly WorkspaceRefV1[];
      workspaceSyncRelationshipsV1: readonly WorkspaceSyncRelationshipV1[];
    }>;
  }>>;
}>;

type HostCoordinatorInput = Readonly<{
  operationId: string;
  actionInput: unknown;
  start: (privateActionInput: unknown) => Promise<ActionExecuteResult>;
  signal: AbortSignal;
  publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
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
    resolveSpawnSessionByNonce: async (spawnNonce, timeoutMs) => normalizeSpawnSessionNonceResolution(
      await input.callMachine({
        credentials: input.credentials,
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
        request: { spawnNonce, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        signal: input.signal,
      }),
    ),
    signal: input.signal,
  });
}

export function buildTrackedSessionHandoffSpawnOptions(params: Readonly<{
  targetMachineId: string;
  prepared: PreparedHandoffTarget;
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
  const awaitTargetCustody = deps.awaitTargetCustody ?? (async (input) => await waitForTargetCustody({
    ...input,
    callMachine,
  }));
  const refreshWorkspaceSettings = deps.refreshWorkspaceSettings ?? (async (input) => {
    const context = await refreshAccountSettingsForMinimumVersion(input);
    return {
      settingsVersion: context.settingsVersion,
      settings: {
        workspaceRefsV1: context.settings.workspaceRefsV1,
        workspaceSyncRelationshipsV1: context.settings.workspaceSyncRelationshipsV1,
      },
    };
  });
  const resolveWorkspaceTransferRoot = deps.resolveWorkspaceTransferRoot ?? resolveWorkspaceTransferRootWithScmWorkspace;

  return async (hostInput: HostCoordinatorInput): Promise<ActionExecuteResult> => {
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
    const credentials = await deps.readCredentials();
    if (!credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const source = await resolveSource(credentials, sessionId, hostInput.signal);
    if (!source.ok) return source;
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
    const accountServerId = readNonEmptyString(rawInput.accountServerId);
    if (daemonMaterializesEndpoints && accountServerId !== deps.expectedAccountServerId.trim()) {
      return { ok: false, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
    }
    if (targetReplacementApproval && (
      !daemonMaterializesEndpoints
      || targetReplacementApproval.operationId !== operationId
      || targetReplacementApproval.serverId !== deps.expectedAccountServerId.trim()
      || targetReplacementApproval.machineId !== targetMachineId
    )) {
      return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
    }
    let workspaceContext: ReturnType<typeof resolveSessionHandoffWorkspaceContext> | undefined;
    let sessionRelativeCwd = '';
    let sourceWorkspaceRootPath = source.sourceRootPath;
    if (workspaceAction?.kind === 'relationship' || workspaceAction?.kind === 'linked_workspace') {
      try {
        // Endpoint identity and the settings version that proves it are
        // daemon-owned: read the canonical Account settings owner rather than
        // trusting a caller-supplied ref id or version floor.
        const settings = await refreshWorkspaceSettings({ credentials });
        const sessionCwd = source.sourceRootPath;
        if (!sessionCwd) throw Object.assign(new Error('Source workspace path is unavailable'), { code: 'workspace_ref_not_ready' });
        const selectedRelationship = workspaceAction.kind === 'relationship'
          ? settings.settings.workspaceSyncRelationshipsV1.find((relationship) => relationship.relationshipId === workspaceAction.relationshipId)
          : undefined;
        const sourceCandidates = settings.settings.workspaceRefsV1.filter((ref) => (
          ref.machineId === source.sourceMachineId
          && getPathRemainderWithinBase(sessionCwd, ref.rootPath) !== null
          && (workspaceAction.kind !== 'relationship' || !selectedRelationship
            || ref.id === selectedRelationship.alphaWorkspaceRefId || ref.id === selectedRelationship.betaWorkspaceRefId)
        ));
        if (sourceCandidates.length !== 1) {
          throw Object.assign(new Error('Source workspace is not uniquely identified'), { code: 'relationship_source_mismatch' });
        }
        sourceWorkspaceRootPath = sourceCandidates[0]!.rootPath;
        sessionRelativeCwd = getPathRemainderWithinBase(sessionCwd, sourceWorkspaceRootPath)!;
        const sourceHasGitLink = workspaceAction.kind === 'relationship'
          ? selectedRelationship?.contentPolicy.selection === 'git_worktree'
          : settings.settings.workspaceSyncRelationshipsV1.some((relationship) => (
            (relationship.alphaWorkspaceRefId === sourceCandidates[0]!.id || relationship.betaWorkspaceRefId === sourceCandidates[0]!.id)
            && relationship.contentPolicy.selection === 'git_worktree'
          ));
        if (sourceHasGitLink) {
          const transferRoot = await resolveWorkspaceTransferRoot({ sessionCwd });
          if (!transferRoot || transferRoot.repositoryRoot !== sourceWorkspaceRootPath) {
            throw Object.assign(new Error('Git worktree selection is unavailable for the source'), { code: 'git_selection_unavailable' });
          }
        }
        workspaceContext = resolveSessionHandoffWorkspaceContext({
          action: workspaceAction,
          workspaceRefs: settings.settings.workspaceRefsV1,
          relationships: settings.settings.workspaceSyncRelationshipsV1,
          sourceMachineId: source.sourceMachineId,
          sourceRootPath: sourceWorkspaceRootPath,
          targetMachineId,
          ...(targetPath ? { targetRootPath: targetPath } : {}),
        });
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
    const workspaceHandoffMethods = new Set<string>([
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
    ]);
    const rpc = async (machineId: string, method: string, request: unknown, signal?: AbortSignal) => {
      try {
        return await callMachine(buildTrackedSessionHandoffMachineCall({
          credentials,
          machineId,
          method,
          request,
          ...(signal ? { signal } : {}),
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
        ...(preservesWorkspaceSessionPath && workspaceTargetRootPath
          ? { workspaceSyncTargetSessionRelativeCwd: sessionRelativeCwd }
          : {}),
        ...(rawInput.targetSessionStorageMode === 'direct' || rawInput.targetSessionStorageMode === 'persisted'
          ? { targetSessionStorageMode: rawInput.targetSessionStorageMode }
          : {}),
        ...(workspaceAction ? { workspaceAction } : {}),
        ...(daemonMaterializesEndpoints ? { accountServerId: deps.expectedAccountServerId.trim() } : {}),
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
      start: async () => await hostInput.start(privateStartInput),
      resolveSource: async () => source,
      prepareTarget: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
        request,
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
        const settled = await awaitTargetCustody({
          credentials,
          machineId: targetMachineId,
          sessionId: expectedSessionId,
          spawnNonce,
          spawnResult,
          signal,
        });
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
}
