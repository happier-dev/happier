import { readAgentIsolationMemberDirectories } from '@/daemon/agentIsolation/prepareNativeOperation';
import { matchesTerminalRequesterCustody } from '@/terminal/pty/custody';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonTerminalCloseRequestSchema, DaemonTerminalEnsureRequestSchema, DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema, DaemonTerminalInputRequestSchema, DaemonTerminalResizeRequestSchema, DaemonTerminalRestartRequestSchema, DaemonTerminalStreamReadRequestSchema } from '@happier-dev/protocol/daemon/terminal';
import { TerminalStreamAckRequestSchema, TerminalStreamAckResponseSchema, TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { TerminalStreamInputRequestSchema, TerminalStreamInputResponseSchema } from '@happier-dev/protocol/terminal/input';
import type { DaemonTerminalErrorCode, TerminalStreamAckRequest, TerminalStreamAckResponse, TerminalStreamInputRequest, TerminalStreamInputResponse, TerminalStreamReadRequest, TerminalStreamReadResponse } from '@happier-dev/protocol';
import type { DaemonTerminalError, DaemonTerminalShellAvailabilityV1 } from '@happier-dev/protocol/daemon/terminal';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { normalizeWorkspaceRootPathV1, projectWorkspaceRefV1, resolveWorkspaceRefV1, workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { StoredCredentials } from '@/persistence';
import type { ApiMachineClient } from '@/api/apiMachine';
import { requireAgentIsolationMaterialNativeIdentity, type AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { hostname } from 'node:os';
import { logger } from '@/ui/logger';
import { readOwnSessionMachineWorkspace } from '@/session/machineControlLocality';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { resolveLocalServiceRunTargetScriptName } from '@/daemon/local/services/launch/runTargets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectRuntimeAccountAccess } from '@/workspaces/projectAccountRows';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { prepareProjectWorktreeRuntime } from '@/workspaces/execution/projectWorktreeRuntime';
import { createProjectDotenvPreparation } from '@/workspaces/projectSetup/projectDotenv';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { dispatchActionFromRpc, type RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { isPluginError } from '@happier-dev/protocol/plugins/errors';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import {
  resolveFilesystemAccessPolicy,
  type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { openServiceShellTerminal } from './serviceShellTerminal';
import { selectHostRequesterExecutionIdentity, resolveHostRequesterAgentExecutionIdentity, resolveHostRequesterAgentPlacementForHost, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createTerminalPtySessionManager, type TerminalPtySessionManager, type TerminalPtyCustody } from '@/terminal/pty/sessions';
import { byteStreamHoldEndsAtMs, readByteStreamHeld } from '@/terminal/pty/byteStreamHold';
import { createNodePtyProvider } from '@/terminal/pty/provider';
import { resolveTerminalShell } from '@/terminal/pty/shells';
import { getSharedTerminalProcessRegistry, type TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import {
  resolveDaemonTerminalLaunch,
  AgentLoginLaunchError,
  type TerminalLaunchProcess,
} from '@/terminal/pty/launch';

function err(errorCode: DaemonTerminalErrorCode): { ok: false; errorCode: DaemonTerminalErrorCode; error: DaemonTerminalErrorCode } {
  return { ok: false, errorCode, error: errorCode };
}

function sameTerminalCustody(left: TerminalPtyCustody | null, right: TerminalPtyCustody): boolean {
  return left !== null && left.serverId === right.serverId && left.requesterAccountId === right.requesterAccountId
    && left.machineId === right.machineId && left.installationId === right.installationId && left.rootPath === right.rootPath
    && (right.kind === 'session' ? left.kind === 'session' && left.sessionId === right.sessionId
      : right.kind === 'machine' ? left.kind === 'machine'
      : left.kind === undefined && left.workspaceRefId === right.workspaceRefId && left.projectKey === right.projectKey);
}

type TerminalByteStreamBridge = Readonly<{
  readByteStream?: (input: TerminalStreamReadRequest) => Promise<TerminalStreamReadResponse> | TerminalStreamReadResponse;
  acknowledgeByteStream?: (input: TerminalStreamAckRequest) => Promise<TerminalStreamAckResponse> | TerminalStreamAckResponse;
  inputEvent?: (input: TerminalStreamInputRequest) => Promise<TerminalStreamInputResponse> | TerminalStreamInputResponse;
}>;

type TerminalBridgeSessionManager = TerminalPtySessionManager & TerminalByteStreamBridge;
export type ProjectTerminalRuntime = ProjectFiniteActionRuntime & Readonly<{
  operationRuntime: Pick<HostActionOperationRuntime, 'observeExecution' | 'waitForProjectTerminalAttachment'> & Readonly<{
    runner: Pick<HostActionOperationRuntime['runner'], 'waitForTerminal'>;
  }>;
}>;

export type MachineTerminalRpcRegistration = Readonly<{
  /** Host-private access to the same lazy process/output owner used by terminal RPC. */
  getSessionManager: () => TerminalBridgeSessionManager;
  cleanupRequesterMachineTerminals: (input: Readonly<{
    serverId: string;
    requesterAccountId: string;
    machineId: string;
    installationId: string;
    remainingRole?: 'use';
    signal: AbortSignal;
    isCurrentInstallation: () => boolean;
  }>) => Promise<Readonly<{ kind: 'settled' | 'incomplete' }>>;
  dispose: () => void;
}>;

export type MachineTerminalRpcHandlerDeps = Readonly<{
  /** Captured Home of the installed Machine RPC owner, not a request field. */
  serverId?: string;
  /** Canonical Home held by the installed Machine owner, never a request field. */
  resolveHostHomeServerIdentityId?: (signal?: AbortSignal) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  workingDirectory?: string;
  accessPolicy?: FilesystemAccessPolicy;
  sessionManager?: TerminalBridgeSessionManager;
  terminalRegistry?: TerminalProcessRegistry;
  admissionDrain?: DaemonAdmissionDrain;
  operationRuntime?: Pick<HostActionOperationRuntime, 'observeExecution'>;
  resolveLaunch?: (launch: import('@happier-dev/protocol').DaemonTerminalLaunchIntent) => TerminalLaunchProcess | Promise<TerminalLaunchProcess>;
  projectFiniteRuntime?: (ingress: RpcHandlerContext) => ProjectTerminalRuntime | null | Promise<ProjectTerminalRuntime | null>;
  /** Requester Account reads for Session and accepted Project custody. */
  accountReadRuntime?: (ingress: RpcHandlerContext) => MachineTerminalOwnSessionReadRuntime | null | Promise<MachineTerminalOwnSessionReadRuntime | null>;
  /** The real receiving Action executor owns invocation policy, consent and finite launch. */
  projectScriptExecutor?: (runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext) => RpcActionExecutor | Promise<RpcActionExecutor>;
  /**
   * Narrows the canonical terminal owner to one Session-scoped Machine runtime.
   * Omitted attribution is stamped with this value; an explicit sibling Session
   * is rejected before a terminal is opened.
   */
  requiredSessionId?: string;
  readSpawnFailureLimits?: import('@/processes/spawnFailure/classifySpawnFailure').SpawnFailureLimitsReader;
  ownerRemainder?: import('@/daemon/processes/endOwnerRemainder').OwnerRemainderPort;
  agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
  /** Same Machine native-operation owner used by Session, raw execution and MCP. */
  nativeOperationRuntime?: Pick<ApiMachineClient, 'prepareNativeOperation' | 'prepareConnectedAccountProcessEnvironment'>;
}>;

export type MachineTerminalAccountReadRuntime = Readonly<{
  serverId: string;
  machineId: string;
  accountId: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  isCurrent?: () => Promise<boolean>;
}>;
export type MachineTerminalOwnSessionReadRuntime = Omit<MachineTerminalAccountReadRuntime, 'credentials'> & ProjectRuntimeAccountAccess;

function terminalStreamUnavailable(): { ok: false; code: 'terminal_byte_stream_unavailable'; message: string } {
  return {
    ok: false,
    code: 'terminal_byte_stream_unavailable',
    message: 'Terminal byte stream is not available on this daemon.',
  };
}

function terminalStreamInvalidRequest(): { ok: false; code: 'terminal_invalid_request'; message: string } {
  return {
    ok: false,
    code: 'terminal_invalid_request',
    message: 'terminal_invalid_request',
  };
}

function terminalStreamDisabled(): { ok: false; code: 'terminal_disabled'; message: string } {
  return {
    ok: false,
    code: 'terminal_disabled',
    message: 'terminal_disabled',
  };
}

export function registerMachineTerminalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  deps?: MachineTerminalRpcHandlerDeps;
}>): MachineTerminalRpcRegistration {
  const rpcHandlerManager = params.rpcHandlerManager;
  const env = params.deps?.env ?? process.env;
  const config = readDaemonTerminalPtyConfig(env);
  const workingDirectory =
    params.deps?.workingDirectory
    ?? resolveMachineRpcWorkingDirectory({ env });
  const accessPolicy = params.deps?.accessPolicy ?? resolveFilesystemAccessPolicy({ env, platform: params.deps?.platform });
  // Default to the daemon-process shared registry so spawn-time registration writes to
  // the exact store the local-services scanner queries (same process). An explicit dep
  // can override (tests / future injection).
  const terminalRegistry = params.deps?.terminalRegistry ?? getSharedTerminalProcessRegistry();
  const resolveLaunch = params.deps?.resolveLaunch
    ?? ((launch) => resolveDaemonTerminalLaunch(launch, { env, platform: params.deps?.platform }));
  const resolveRequestedLaunch = async (launch: Exclude<import('@happier-dev/protocol').DaemonTerminalLaunchIntent, { kind: 'package_script' | 'service_shell' }> | undefined) => {
    try {
      return { ok: true as const, launchProcess: launch ? await resolveLaunch(launch) : undefined };
    } catch (error) {
      return err(error instanceof AgentLoginLaunchError ? error.code : 'terminal_spawn_failed');
    }
  };

  let sessionManager: TerminalBridgeSessionManager | null = params.deps?.sessionManager ?? null;
  /** Admitted finite output: its retained custody, not a person floor, decides the read. */
  const isFiniteOutputRead = (terminalId: string | undefined): boolean =>
    terminalId !== undefined && sessionManager?.isFiniteRun(terminalId) === true;
  const getSessionManager = (): TerminalBridgeSessionManager => {
    if (sessionManager) return sessionManager;
    sessionManager = createTerminalPtySessionManager({
      ptyProvider: createNodePtyProvider({ env, readSpawnFailureLimits: params.deps?.readSpawnFailureLimits }),
      readSpawnFailureLimits: params.deps?.readSpawnFailureLimits,
      ownerRemainder: params.deps?.ownerRemainder,
      config: config.sessionManager,
      env,
      platform: params.deps?.platform,
      terminalRegistry,
    });
    return sessionManager;
  };

  const resolveCwd = (cwdInput: unknown): { ok: true; cwd: string } | ReturnType<typeof err> => {
    const raw = typeof cwdInput === 'string' && cwdInput.trim().length > 0 ? cwdInput.trim() : workingDirectory;
    const expanded = expandHomeDirPath(raw, env, params.deps?.platform);

    const validation = authorizeFilesystemPath({ targetPath: expanded, defaultDirectory: workingDirectory,
      accessPolicy, platform: params.deps?.platform });
    if (!validation.valid) {
      return err('terminal_cwd_denied');
    }
    return { ok: true, cwd: validation.resolvedPath ?? expanded };
  };

  const resolveRequesterIdentity = async (context?: RpcHandlerContext): Promise<Readonly<{
    identity: HostRequesterExecutionIdentity;
    homeServerIdentityId: string | null;
    cause?: unknown;
  }>> => {
    try {
      const signedHome = context?.callerInputAuthorization?.binding.serverIdentityId;
      const home = params.deps?.resolveHostHomeServerIdentityId
        ? await params.deps.resolveHostHomeServerIdentityId(context?.signal)
        : signedHome ?? (params.deps?.serverId ? await resolveServerProfileHomeIdentityId(params.deps.serverId) : null);
      return { identity: selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: home }), homeServerIdentityId: home };
    } catch (cause) { return { identity: { kind: 'unknown', reason: 'requester_authority_unavailable' }, homeServerIdentityId: null, cause }; }
  };

  const unavailableIdentityTransport = (cause?: unknown) => ({ ...err('terminal_unavailable'), error: 'agent_isolation_unavailable',
    ...(cause === undefined ? {} : { failureCause: normalizeActionExecutorThrownError(cause, 'terminal.machine_shell').failureCause }) });

  // A custodian's own terminal needs no requester separation. Agent provenance
  // remains intact; other Accounts retain their configured native placement.
  const resolveTerminalAgentIsolation = (identity: HostRequesterExecutionIdentity, context?: RpcHandlerContext) =>
    identity.kind === 'isolated' && !identity.separationRequired
      && identity.requester.accountId === context?.machineAdmission?.custodianAccountId
      ? undefined : params.deps?.agentIsolation;

  const resolveTerminalPlacement = (identity: HostRequesterExecutionIdentity, context?: RpcHandlerContext) => {
    const requester = resolveHostRequesterAgentExecutionIdentity(identity);
    return requester.kind === 'isolated'
      ? resolveHostRequesterAgentPlacementForHost({ identity: requester,
        snapshot: resolveTerminalAgentIsolation(identity, context)?.read(), platform: params.deps?.platform })
      : undefined;
  };

  const resolveMachineShellAvailability = async (context?: RpcHandlerContext,
    selectedIdentity?: HostRequesterExecutionIdentity): Promise<DaemonTerminalShellAvailabilityV1> => {
    const admission = context?.machineAdmission;
    if (!context || !admission || context.signal.aborted || params.deps?.requiredSessionId) return err('terminal_forbidden');
    const resolvedRequester = selectedIdentity ? { identity: selectedIdentity } : await resolveRequesterIdentity(context);
    const identity = resolvedRequester.identity;
    if (identity.kind === 'unknown') return unavailableIdentityTransport(resolvedRequester.cause);
    const memberRequester = resolveHostRequesterAgentExecutionIdentity(identity);
    const placement = resolveTerminalPlacement(identity, context);
    if (admission.role !== 'manage') {
      if (identity.kind !== 'isolated' || placement !== 'member') return err('terminal_forbidden');
      if (!params.deps?.nativeOperationRuntime) return unavailableIdentityTransport();
    }
    if (placement === 'member' && (admission.actorAccountId !== admission.custodianAccountId || admission.role !== 'manage')) {
      if (memberRequester.kind !== 'isolated' || !params.deps?.agentIsolation?.readMember) return unavailableIdentityTransport();
      try {
        const member = await readAgentIsolationMemberDirectories(params.deps.agentIsolation, {
          requesterIdentity: { ...memberRequester, homeServerIdentityId: memberRequester.requester.serverId },
          rpcContext: context, signal: context.signal,
        });
        const cwd = resolveCwd(member.workspaceRoot);
        return cwd.ok ? { ...cwd, ...(member.preparation ? { preparation: member.preparation } : {}) } : cwd;
      } catch (cause) { return unavailableIdentityTransport(cause); }
    }
    return resolveCwd(undefined);
  };

  const runServiceShell = async (request: Pick<import('@happier-dev/protocol').DaemonTerminalEnsureRequest, 'terminalKey' | 'cols' | 'rows'> & Readonly<{
    launch: Extract<import('@happier-dev/protocol').DaemonTerminalLaunchIntent, { kind: 'service_shell' }>;
  }>, context: RpcHandlerContext | undefined, actionId: 'machines.terminal.open' | 'machines.terminal.restart', homeServerIdentityId: string | null) => {
    if (!context?.machineAdmission || !params.deps?.serverId || !params.deps.operationRuntime || params.deps.requiredSessionId)
      return err('terminal_unavailable');
    const admitted = await resolveTerminalCustody({}, context);
    if (!admitted.ok) return admitted;
    if (!admitted.custody || admitted.custody.kind !== 'machine') return err('terminal_forbidden');
    return openServiceShellTerminal({ request, actionId, context, custody: { ...admitted.custody,
      ...(homeServerIdentityId ? { homeServerIdentityId } : {}) },
      terminalSessions: getSessionManager(), operationRuntime: params.deps.operationRuntime,
      ...(params.deps.admissionDrain ? { admissionDrain: params.deps.admissionDrain } : {}) });
  };

  const hasRequiredSessionAuthority = (context?: RpcHandlerContext): boolean => {
    if (!params.deps?.requiredSessionId) return false;
    // The restricted Runner's existing receiver proves this Session before
    // dispatch. In-process legacy invocation stays in that same private owner.
    return !context?.machineAdmission || context.authorization?.kind === 'session.write'
      && context.authorization.sessionId === params.deps.requiredSessionId;
  };

  const resolveOwnSessionCustody = async (sessionId: string, cwdInput: string | undefined, context: RpcHandlerContext)
    : Promise<Readonly<{ ok: true; cwd: string; custody: TerminalPtyCustody }> | ReturnType<typeof err>> => {
    const admission = context.machineAdmission;
    if (!admission || context.signal.aborted) return err('terminal_forbidden');
    const runtime = await params.deps?.accountReadRuntime?.(context);
    if (!runtime) return err('terminal_unavailable');
    if (runtime.accountId !== admission.actorAccountId) return err('terminal_forbidden');
    if (runtime.machineId !== admission.machineId || params.deps?.serverId !== undefined && runtime.serverId !== params.deps.serverId) return err('terminal_forbidden');
    try {
      if (runtime.isCurrent && !await runtime.isCurrent()) return err('terminal_forbidden');
      const request = { sessionId, machineId: admission.machineId, signal: context.signal,
        currentMachineHost: hostname(), currentMachineHomeDir: resolveHomeDirFromEnvironment(env, params.deps?.platform),
        ...(cwdInput === undefined ? {} : { candidatePath: cwdInput }) };
      const workspace = runtime.accountAuthorization
        ? await runtime.accountAuthorization.requesterAccountProjection?.readOwnSessionWorkspace?.(request)
        : await readOwnSessionMachineWorkspace({ ...request, credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl });
      if (!workspace) return err('terminal_forbidden');
      const root = resolveCwd(workspace.rootPath);
      if (!root.ok) return root;
      if (cwdInput !== undefined) {
        const requested = resolveCwd(workspace.requestedPath ?? cwdInput);
        if (!requested.ok || normalizeWorkspaceRootPathV1(requested.cwd) !== normalizeWorkspaceRootPathV1(root.cwd)) return err('terminal_cwd_denied');
      }
      if (context.signal.aborted) return err('terminal_forbidden');
      return { ok: true, cwd: root.cwd, custody: { kind: 'session', serverId: runtime.serverId,
        requesterAccountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId,
        sessionId, rootPath: root.cwd, ...(workspace.requiresManagedTarget ? { requiresManagedTarget: true as const } : {}) } };
    } catch { return err('terminal_forbidden'); }
  };

  const resolveTerminalCustody = async (input: Readonly<{ workspace?: WorkspaceAddressV1; cwd?: string; sessionId?: string; launch?: import('@happier-dev/protocol').DaemonTerminalLaunchIntent }>, context?: RpcHandlerContext,
    requesterIdentity?: HostRequesterExecutionIdentity)
    : Promise<Readonly<{ ok: true; cwd: string; custody?: TerminalPtyCustody }> | ReturnType<typeof err> | DaemonTerminalError> => {
    if (hasRequiredSessionAuthority(context)) {
      if (input.workspace) return err('terminal_invalid_request');
      if (context?.machineAdmission && context.signal.aborted) return err('terminal_forbidden');
      return resolveCwd(input.cwd);
    }
    if (!context?.machineAdmission) {
      if (input.workspace) return err('terminal_forbidden');
      return resolveCwd(input.cwd);
    }
    const sessionId = input.sessionId ?? (input.launch?.kind === 'session_attach' ? input.launch.sessionId : undefined);
    if (sessionId) {
      if (input.workspace || input.launch?.kind === 'session_attach' && input.launch.sessionId !== sessionId) return err('terminal_invalid_request');
      return await resolveOwnSessionCustody(sessionId, input.cwd, context);
    }
    if (context.signal.aborted) return err('terminal_forbidden');
    const admission = context.machineAdmission;
    // The Machine owns a person's shell; Project and Session targets keep
    // their accepted custody. Use can select only its native member root.
    if (!input.workspace) {
      if (!params.deps?.serverId) return err('terminal_unavailable');
      const shell = admission.role === 'manage' && input.cwd !== undefined
        ? resolveCwd(input.cwd) : await resolveMachineShellAvailability(context, requesterIdentity);
      if (!shell.ok) return shell;
      const cwd = admission.role === 'manage' || input.cwd === undefined ? shell : resolveCwd(input.cwd);
      if (!cwd.ok) return cwd;
      if (admission.role !== 'manage'
        && normalizeWorkspaceRootPathV1(cwd.cwd) !== normalizeWorkspaceRootPathV1(shell.cwd)) return err('terminal_cwd_denied');
      return { ok: true, cwd: cwd.cwd, custody: { kind: 'machine', serverId: params.deps.serverId,
        requesterAccountId: admission.actorAccountId, machineId: admission.machineId,
        installationId: admission.installationId, rootPath: cwd.cwd } };
    }
    const runtime = await params.deps?.accountReadRuntime?.(context);
    // The requester Account owner must supply its own ports. Machine Use never
    // authorizes reading the custodian's private accepted-workspace catalog.
    if (!runtime || runtime.accountId !== admission.actorAccountId) return err('terminal_unavailable');
    if (runtime.machineId !== admission.machineId || params.deps?.serverId !== undefined && runtime.serverId !== params.deps.serverId) return err('terminal_forbidden');
    if (input.workspace && (!await isServerProfileHomeIdentity(runtime.serverId, input.workspace.serverId)
      || input.workspace.machineId !== runtime.machineId)) return err('terminal_cwd_denied');
    try {
      if (runtime.isCurrent && !await runtime.isCurrent()) return err('terminal_forbidden');
      const selectedHomeServerId = await resolveServerProfileHomeIdentityId(runtime.serverId) ?? runtime.serverId;
      const rows = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => readProjectAccountRows({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, signal: context.signal,
        selection: { kinds: ['workspace-ref'], serverId: selectedHomeServerId },
      }));
      const cwd = resolveCwd(input.workspace?.rootPath ?? input.cwd);
      if (!cwd.ok) return cwd;
      if (input.workspace && input.cwd !== undefined) {
        const requested = resolveCwd(input.cwd);
        if (!requested.ok || normalizeWorkspaceRootPathV1(requested.cwd) !== normalizeWorkspaceRootPathV1(cwd.cwd)) return err('terminal_cwd_denied');
      }
      const homeServerId = await resolveServerProfileHomeIdentityId(runtime.serverId) ?? runtime.serverId;
      const accepted = resolveWorkspaceRefV1(rows.workspaceRefs, input.workspace ?? {
        serverId: runtime.serverId, machineId: runtime.machineId, rootPath: cwd.cwd,
      }, { normalizeServerId: id => id === runtime.serverId ? homeServerId : id });
      if (accepted.kind !== 'resolved') return err('terminal_cwd_denied');
      const acceptedCwd = resolveCwd(accepted.ref.rootPath);
      if (!acceptedCwd.ok || normalizeWorkspaceRootPathV1(acceptedCwd.cwd) !== normalizeWorkspaceRootPathV1(cwd.cwd)) return err('terminal_cwd_denied');
      if (context.signal.aborted) return err('terminal_forbidden');
      return { ok: true, cwd: acceptedCwd.cwd, custody: {
        serverId: runtime.serverId, requesterAccountId: admission.actorAccountId, machineId: admission.machineId,
        installationId: admission.installationId, workspaceRefId: accepted.ref.id,
        projectKey: projectWorkspaceRefV1(accepted.ref).projectKey, rootPath: acceptedCwd.cwd,
      } };
    } catch { return err('terminal_forbidden'); }
  };

  /** Open-ended viewers end on Machine access loss; other reads end at their next admission. */
  const heldByteStreamReaders = new Set<Readonly<{ terminalId: string; retire: () => void }>>();

  const authorizeTerminal = async (terminalId: string, context?: RpcHandlerContext, purpose: 'control' | 'census' | 'retire' | 'finite_output' = 'control',
    admittedCensusCustody?: TerminalPtyCustody): Promise<boolean> => {
    // The canonical selector establishes the requester. Native material and
    // retained custody below decide whether it can control this terminal.
    const requesterIdentity = purpose === 'control' ? (await resolveRequesterIdentity(context)).identity : undefined;
    if (requesterIdentity?.kind === 'unknown') return false;
    const manager = getSessionManager();
    const custody = manager.getCustody(terminalId);
    const terminal = manager.list().find(candidate => candidate.terminalId === terminalId);
    // Removal ends terminal custody. A still-admitted reader must reach the
    // manager's not-found result; only a live owner can require custody checks.
    if (!terminal) return context?.machineAdmission
      ? !context.signal.aborted
      : !params.deps?.requiredSessionId;
    if (requesterIdentity?.kind === 'isolated'
      && resolveTerminalPlacement(requesterIdentity, context) !== 'daemon') {
      const nativeIdentity = manager.getNativeExecutionIdentity?.(terminalId);
      if (!nativeIdentity) return false;
      try {
        requireAgentIsolationMaterialNativeIdentity(nativeIdentity, { ...requesterIdentity,
          homeServerIdentityId: requesterIdentity.requester.serverId });
      } catch { return false; }
    }
    if (params.deps?.requiredSessionId && terminal.sessionId !== params.deps.requiredSessionId) return false;
    if (hasRequiredSessionAuthority(context)) return !context?.machineAdmission || !context.signal.aborted;
    if (!context?.machineAdmission) {
      if (custody !== null) logger.debug('[terminal] Authorization denied', { reason: 'machine_admission_required' });
      return custody === null;
    }
    const admission = context.machineAdmission;
    if (!custody || !matchesTerminalRequesterCustody(custody, { serverId: params.deps?.serverId ?? '',
      accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId })) return false;
    if (custody.kind === 'machine') return (admission.role === 'manage' || !!manager.getNativeExecutionIdentity?.(terminalId))
      && custody.serverId === params.deps?.serverId && !context.signal.aborted;
    if (custody.kind === 'session') {
      if (terminal.sessionId !== custody.sessionId) return false;
      // The native owner retained Session custody at birth. Each incoming
      // control already has current Machine admission; private Session content
      // is not an authority for this retained PTY.
      return custody.serverId === params.deps?.serverId && !context.signal.aborted;
    }
    if (terminal.sessionId && terminal.sessionId !== params.deps?.requiredSessionId
      && terminal.sessionId !== context.sessionActionOrigin?.caller.sessionId) return false;
    // Retained Project custody is immutable after native birth. Qualified
    // discovery additionally matches the accepted namespace resolved above.
    return custody.serverId === params.deps?.serverId && !context.signal.aborted
      && (!admittedCensusCustody || sameTerminalCustody(custody, admittedCensusCustody));
  };

  const settleTerminalClose = async (terminalId: string, signal?: AbortSignal) => {
    const manager = getSessionManager();
    if (manager.isServiceOwned(terminalId)) return err('terminal_busy');
    const requested = await manager.requestStop({ terminalId });
    if (requested.kind === 'unconfirmed' || requested.kind === 'unavailable') return err('terminal_busy');
    if (requested.kind === 'requested') {
      const settled = await manager.waitForExit({ terminalId, ...(signal ? { signal } : {}) });
      if (settled.kind !== 'exited') return err('terminal_busy');
    }
    return manager.close({ terminalId });
  };

  const projectActionContext = (context: RpcHandlerContext) => ({ ...context.localActionContext,
    surface: context.localActionContext?.surface ?? 'api' as const,
    actionRequestId: context.localActionContext?.actionRequestId ?? context.sessionActionOrigin?.requestId ?? context.transportRequestId });

  const dispatchProjectAction = async (runtime: ProjectTerminalRuntime, context: RpcHandlerContext,
    actionId: 'projects.prepare' | 'projects.script.run', input: unknown) => {
    if (!params.deps?.projectScriptExecutor) throw Object.assign(new Error('project_finite_execution_unavailable'), { code: 'project_finite_execution_unavailable' });
    const executor = await params.deps.projectScriptExecutor(runtime, context);
    return await dispatchActionFromRpc({ actionId, input, executor, serverId: runtime.serverId,
      externalActionTarget: { kind: 'machine', machineId: runtime.machineId }, signal: context.signal,
      machineAdmission: context.machineAdmission, verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent,
      requesterSessionBootstrap: context.requesterSessionBootstrap, callerInputAuthorization: context.callerInputAuthorization,
      callerInputConstraints: context.callerInputConstraints, workspaceSyncSourceRouting: context.workspaceSyncSourceRouting,
      workspaceSyncSourceWriterTargetRouting: context.workspaceSyncSourceWriterTargetRouting,
      callerAuthority: context.callerAuthority, sessionActionOrigin: context.sessionActionOrigin,
      ...(context.authorization?.kind === 'session.write' ? { rpcSessionAuthorization: context.authorization } : {}),
      runtimeAccountId: context.machineAdmission!.actorAccountId,
      localActionContext: projectActionContext(context),
    });
  };
  const observeShellReleaseFailure = () => logger.debug('[terminal] Project shell native resources remain unsettled');

  /** Terminal admission covers the shell and native environment; setup is a separate Action. */
  const prepareProjectShell = async (custody: Extract<TerminalPtyCustody, { kind?: undefined }>,
    launchProcess: TerminalLaunchProcess | undefined, context: RpcHandlerContext | undefined,
    requesterIdentity: HostRequesterExecutionIdentity,
    nativeOperation?: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>) => {
    const refused = (code: string, details?: unknown) => ({ ...err('terminal_invalid_request'), error: code,
      ...(details === undefined ? {} : { details }) });
    if (!context?.machineAdmission) return refused('machine_admission_required');
    let release: (() => Promise<void>) | undefined;
    try {
      const runtime = await params.deps?.projectFiniteRuntime?.(context);
      if (!runtime || runtime.accountId !== custody.requesterAccountId || runtime.machineId !== custody.machineId
        || runtime.serverId !== custody.serverId) return refused('project_requester_credentials_unavailable');
      if (runtime.terminalSessions !== getSessionManager()) return refused('project_terminal_owner_mismatch');
      const [{ resolveProjectSetupAcceptedWorkspace }, { reviewProjectExecutionEnvironment },
        { createProjectNativeInvocationCustody, createProjectNativeLaunchAdmission }, { authorizeResolvedProjectExecLaunchForHost },
        { readProjectEffectiveDefinition }, { resolveProjectRequesterSecretInputs }] = await Promise.all([
        import('@/workspaces/projectSetup/projectSetupAcceptedWorkspace'), import('@/workspaces/projectSetup/projectSetupPreparation'),
        import('@/workspaces/projectSetup/projectSetupExecution'), import('@/plugins/runtime/invocation/services/exec'),
        import('@/workspaces/projectSetup/projectEffectiveDefinition'), import('@/workspaces/projectSetup/projectSetupRequesterInputs'),
      ]);
      const assertCurrent = async () => {
        context.signal.throwIfAborted();
      };
      await assertCurrent();
      const accountAccess = projectRuntimeAccountRowsInput(runtime);
      const association = await resolveProjectSetupAcceptedWorkspace({ ...accountAccess,
        serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal,
        address: { serverId: custody.serverId, workspaceId: custody.workspaceRefId, machineId: custody.machineId, rootPath: custody.rootPath } });
      if (association.workspace.projectKey !== custody.projectKey) return refused('project_workspace_changed');
      const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath, account: accountAccess,
        project: association.project, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal });
      const { environmentBindings, secretEnvironment } = await resolveProjectRequesterSecretInputs(runtime, {
        project: association.project,
        requirements: definition.effectiveDefinition.effectiveManifest?.environmentVariables ?? [],
      }, context.signal);
      const platform = runtime.platform ?? params.deps?.platform ?? process.platform;
      const hostEnvironment = Object.freeze({ ...(runtime.hostEnvironment ?? env) });
      const runtimeBindings = await prepareProjectWorktreeRuntime({ workspace: association.workspace,
        manifest: definition.effectiveDefinition.effectiveManifest, signal: context.signal });
      if (runtimeBindings.kind !== 'ready') return refused(runtimeBindings.code, { reason: runtimeBindings.reason });
      const nativeCustody = createProjectNativeInvocationCustody({ signal: context.signal });
      let authorized: Awaited<ReturnType<typeof authorizeResolvedProjectExecLaunchForHost>> | undefined;
      release = async () => {
        try { await authorized?.release(); }
        finally {
          try { await nativeCustody.release(); }
          finally { nativeCustody.dispose(); }
        }
      };
      const preparation = { workspace: association.workspace, projectAssociation: association, requesterIdentity,
        acceptedSetup: definition.acceptedSetup,
        dotenvPreparation: createProjectDotenvPreparation(association.workspace.rootPath, hostEnvironment),
        originalEnvironment: hostEnvironment, runtimeEnvironment: runtimeBindings.runtimeEnvironment,
        invocationEnvironment: launchProcess?.env,
        approvalContext: projectActionContext(context),
        requester: { ...accountAccess, serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup' as const,
        platform: { os: platform === 'win32' ? 'windows' : platform, arch: runtime.arch ?? process.arch },
        nativeIo: runtime.nativeIo, signal: context.signal, retainNativeInvocation: nativeCustody.retain,
        ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
        ...(secretEnvironment ? { secretEnvironment } : {}),
        ...(environmentBindings ? { environmentBindings } : {}),
        ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
        ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
      };
      const inspect = async () => {
        await assertCurrent();
        const outcome = await reviewProjectExecutionEnvironment(preparation);
        await assertCurrent();
        if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.code), { code: outcome.code });
        return outcome;
      };
      const inspected = await inspect();
      const plan = inspected.plan;
      const base = launchProcess ?? resolveTerminalShell(hostEnvironment, platform);
      const agentIsolation = nativeOperation?.agentIsolation ?? resolveTerminalAgentIsolation(requesterIdentity, context);
      const execution = requesterIdentity.kind === 'owner_person' ? { executionKind: 'person_break_glass' as const } : {};
      const projectLaunch = createProjectNativeLaunchAdmission({ preparation, hostEnvironment, platform,
        agentIsolation, ...execution, requesterIdentity,
        beforeNativeEffect: assertCurrent,
        environmentIo: runtime.environmentIo, operation: { signal: context.signal } }, plan);
      authorized = await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: base.file, args: base.args, cwd: association.workspace.rootPath, env: projectLaunch.launchEnvironment }, projectLaunch, signal: context.signal,
        agentIsolation, ...execution, requesterIdentity, agentLaunchKind: 'terminal',
        assertCurrent() {
          if (context.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()) throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
        }, ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}),
      });
      return { ok: true as const, authorizedProjectLaunch: authorized,
        validate: assertCurrent, release };
    } catch (error) {
      // The capture owner waits for physical settlement without holding the caller's
      // observation open or interpreting uncertainty as permission to spawn.
      if (release) void release().catch(observeShellReleaseFailure);
      const code = context.signal.aborted ? 'cancelled'
        : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_preparation_unavailable';
      return refused(code, error instanceof Error && 'details' in error ? error.details : undefined);
    }
  };

  const prepareAssociatedTerminalLaunch = async (input: Readonly<{
    launchProcess?: TerminalLaunchProcess;
    nativeSignIn: boolean;
    context: RpcHandlerContext | undefined;
    requesterAccountId: string;
    sessionId: string | undefined;
    terminalKey: string;
    actionId: Parameters<ApiMachineClient['prepareConnectedAccountProcessEnvironment']>[0]['actionId'];
  }>): Promise<TerminalLaunchProcess | undefined> => {
    const runtime = params.deps?.nativeOperationRuntime;
    if (!input.sessionId || input.nativeSignIn || !runtime || !input.context) return input.launchProcess;
    const credentials = await runtime.prepareConnectedAccountProcessEnvironment({
      authorization: input.context.callerInputAuthorization, requesterAccountId: input.requesterAccountId,
      sessionId: input.sessionId, operationId: input.context.transportRequestId ?? input.terminalKey,
      actionId: input.actionId, signal: input.context.signal });
    try {
      const base = input.launchProcess ?? resolveTerminalShell(env, params.deps?.platform ?? process.platform);
      const original = Object.fromEntries(Object.entries({ ...env, ...base.env })
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const produced = await credentials.produce(original, input.context.signal);
      // Keep native removals explicit when later shell owners merge host env.
      return { ...base, env: { ...Object.fromEntries(Object.keys(original).map(key => [key, undefined])), ...produced.environment } };
    } finally { await credentials.dispose(); }
  };

  const prepareNativeShell = async (cwd: string, launchProcess: TerminalLaunchProcess | undefined,
    context: RpcHandlerContext, requesterIdentity: HostRequesterExecutionIdentity,
    nativeOperation: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>) => {
    const { authorizeResolvedProjectExecLaunchForHost } = await import('@/plugins/runtime/invocation/services/exec');
    const base = launchProcess ?? resolveTerminalShell(env, params.deps?.platform ?? process.platform);
    const authorizedProjectLaunch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: base.file, args: base.args, cwd,
        env: Object.fromEntries(Object.entries({ ...env, ...launchProcess?.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) },
      agentIsolation: nativeOperation.agentIsolation, requesterIdentity, agentLaunchKind: 'terminal', signal: context.signal,
      assertCurrent: () => context.signal.throwIfAborted(),
    });
    return { ok: true as const, authorizedProjectLaunch, validate: async () => { context.signal.throwIfAborted(); },
      release: async () => { await authorizedProjectLaunch.release(); } };
  };

  const prepareTerminalNativeOperation = async (context: RpcHandlerContext, requesterIdentity: HostRequesterExecutionIdentity,
    terminalKey: string, sessionId: string | undefined) => {
    if (!params.deps?.nativeOperationRuntime) return undefined;
    let live = true;
    // The terminal's existing retained identity owns this empty person-shell
    // projection. It grants no Session MCP or selected Provider authority.
    const material: AgentLaunchOperationMaterialization = Object.freeze({
      materializationKey: JSON.stringify(['terminal', sessionId ?? null, terminalKey]),
      environment: Object.freeze({}), selectedMaterials: Object.freeze([]),
    });
    try {
      const input = { requesterIdentity, resolveRequesterIdentity: async () => requesterIdentity,
        ingress: context, signal: context.signal, readMaterial: () => live ? material : undefined };
      const prepared = await params.deps.nativeOperationRuntime.prepareNativeOperation(input);
      return { ...prepared, async dispose() { live = false; await prepared.dispose(); } };
    } catch (error) { live = false; throw error; }
  };

  const retainShellLaunch = (prepared: Extract<Awaited<ReturnType<typeof prepareProjectShell>>, { ok: true }>,
    result: Awaited<ReturnType<TerminalPtySessionManager['ensure']>>) => {
    if (result.ok && !result.reused) {
      void getSessionManager().waitForExit({ terminalId: result.terminalId }).then(async observation => {
        if (observation.kind === 'exited') await prepared.release();
        else observeShellReleaseFailure();
      }).catch(observeShellReleaseFailure);
    } else void prepared.release().catch(observeShellReleaseFailure);
    return result;
  };

  const runPackageScript = async (cwd: string, runTargetId: string, context?: RpcHandlerContext) => {
    const refused = (code: string, details?: unknown) => ({ ...err('terminal_invalid_request'), error: code,
      ...(details === undefined ? {} : { details }) });
    const admission = context?.machineAdmission;
    if (!context || !admission) return refused('machine_admission_required');
    try {
      if (context.signal.aborted) return refused('machine_admission_changed');
      const runtime = await params.deps?.projectFiniteRuntime?.(context);
      if (!runtime || !params.deps?.projectScriptExecutor) return refused('project_finite_execution_unavailable');
      if (admission.machineId !== runtime.machineId) return refused('target_mismatch');
      // The accepted Project belongs to the requester Account. Machine custody
      // must not substitute the custodian's credentials for that Account.
      if (admission.actorAccountId !== runtime.accountId) {
        return refused('project_requester_credentials_unavailable');
      }
      const selectedHomeServerId = await resolveServerProfileHomeIdentityId(runtime.serverId) ?? runtime.serverId;
      const rows = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => readProjectAccountRows({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, signal: context.signal,
        selection: { kinds: ['workspace-ref'], serverId: selectedHomeServerId },
      }));
      if (context.signal.aborted) return refused('machine_admission_changed');
      // Directory selects only an exact accepted checkout. Its stored Project anchor,
      // never an inferred enclosing root, supplies preparation/trust association.
      const homeServerId = await resolveServerProfileHomeIdentityId(runtime.serverId) ?? runtime.serverId;
      const accepted = resolveWorkspaceRefV1(rows.workspaceRefs, { serverId: runtime.serverId, machineId: runtime.machineId, rootPath: cwd },
        { normalizeServerId: id => id === runtime.serverId ? homeServerId : id });
      if (accepted.kind !== 'resolved' || !accepted.ref.projectKey) return refused('project_workspace_unavailable');
      const scriptName = await resolveLocalServiceRunTargetScriptName({ cwd: accepted.ref.rootPath, runTargetId });
      if (context.signal.aborted) return refused('machine_admission_changed');
      if (!scriptName) return refused('native_target_missing');
      // The receiving producer must borrow the incumbent PTY, including its rings and holds.
      if (runtime.terminalSessions !== getSessionManager()) return refused('project_terminal_owner_mismatch');
      const result = await dispatchProjectAction(runtime, context, 'projects.script.run',
        { workspace: workspaceAddressFromRefV1(accepted.ref), selection: { kind: 'native', source: {
          kind: 'native', tool: 'package_script', file: 'package.json', target: scriptName,
        } } });
      if (!result.ok) return refused(result.errorCode, result.details);
      const output = ProjectCommandActionOutputV1Schema.safeParse(result.result);
      if (!output.success) return refused('project_script_pending', result.result);
      const operation = await runtime.operationRuntime.waitForProjectTerminalAttachment(
        { accountId: admission.actorAccountId, machineId: runtime.machineId }, output.data.operation.operationId, context.signal,
      );
      if (context.signal.aborted) return refused('machine_admission_changed');
      if (operation?.domainRef?.kind !== 'projectCommand' || operation.domainRef.purpose !== 'script' || !operation.domainRef.terminalId) {
        return refused(operation?.error?.errorCode ?? operation?.observation?.code ?? (operation?.state === 'cancelled' ? 'cancelled' : 'project_terminal_unavailable'));
      }
      return { ok: true as const, terminalId: operation.domainRef.terminalId, reused: false };
    } catch (error) {
      return refused(context.signal.aborted ? 'cancelled'
        : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_finite_execution_unavailable');
    }
  };

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_LIST, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (context?.machineAdmission && context.signal.aborted) return err('terminal_forbidden');
    let qualifiedCustody: TerminalPtyCustody | undefined;
    if (parsed.data.workspace) {
      const admitted = await resolveTerminalCustody({ workspace: parsed.data.workspace }, context);
      if (!admitted.ok) return admitted;
      if (!admitted.custody || admitted.custody.kind === 'session') return err('terminal_forbidden');
      qualifiedCustody = admitted.custody;
    }
    const terminals = [];
    for (const terminal of sessionManager?.list() ?? []) {
      if (qualifiedCustody && !sameTerminalCustody(sessionManager?.getCustody(terminal.terminalId) ?? null, qualifiedCustody)) continue;
      if (await authorizeTerminal(terminal.terminalId, context, 'census', qualifiedCustody)) terminals.push(terminal);
    }
    if (context?.machineAdmission && context.signal.aborted) return err('terminal_forbidden');
    return DaemonTerminalListResponseV1Schema.parse({
      ok: true,
      ...(parsed.data.machineShell ? { machineShell: await resolveMachineShellAvailability(context) } : {}),
      terminals: params.deps?.requiredSessionId
        ? terminals.filter((terminal) => terminal.sessionId === params.deps?.requiredSessionId)
        : terminals,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_ENSURE, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (
      params.deps?.requiredSessionId
      && (
        (parsed.data.sessionId !== undefined && parsed.data.sessionId !== params.deps.requiredSessionId)
        || (parsed.data.launch?.kind === 'session_attach' && parsed.data.launch.sessionId !== params.deps.requiredSessionId)
      )
    ) return err('terminal_invalid_request');

    if (parsed.data.launch?.kind === 'package_script') {
      const cwd = resolveCwd(parsed.data.cwd);
      return cwd.ok ? await runPackageScript(cwd.cwd, parsed.data.launch.runTargetId, context) : cwd;
    }
    const resolvedRequester = await resolveRequesterIdentity(context);
    const { identity: requesterIdentity, homeServerIdentityId } = resolvedRequester;
    const placement = resolveTerminalPlacement(requesterIdentity, context);
    if (requesterIdentity.kind === 'unknown') return unavailableIdentityTransport(resolvedRequester.cause);
    if (parsed.data.launch?.kind === 'service_shell') {
      // Service-native admission owns the shell's execution identity. A Session
      // acting for another Account cannot borrow that identity for separation.
      if (requesterIdentity.kind === 'isolated' && requesterIdentity.separationRequired) return unavailableIdentityTransport();
      return await runServiceShell({ ...parsed.data, launch: parsed.data.launch }, context, 'machines.terminal.open', homeServerIdentityId);
    }
    if (requesterIdentity.kind !== 'owner_person'
      && placement !== 'daemon' && !params.deps?.nativeOperationRuntime) return unavailableIdentityTransport();

    const cwd = await resolveTerminalCustody(parsed.data, context, requesterIdentity);
    if (!cwd.ok) return cwd;
    const launch = await resolveRequestedLaunch(parsed.data.launch);
    if (!launch.ok) return launch;
    const sessionId = params.deps?.requiredSessionId ?? parsed.data.sessionId
      ?? ('custody' in cwd && cwd.custody?.kind === 'session' ? cwd.custody.sessionId : undefined);
    const projectCustody = 'custody' in cwd && cwd.custody?.kind === undefined ? cwd.custody : undefined;
    const warm = 'custody' in cwd && cwd.custody && getSessionManager().list().some(terminal => !terminal.ended
      && terminal.terminalKey === parsed.data.terminalKey && terminal.sessionId === sessionId
      && sameTerminalCustody(getSessionManager().getCustody(terminal.terminalId), cwd.custody!));
    if (projectCustody && !warm && params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
    let nativeOperation: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>> | undefined;
    let prepared: Extract<Awaited<ReturnType<typeof prepareProjectShell>>, { ok: true }> | undefined;
    try {
      if (!warm) launch.launchProcess = await prepareAssociatedTerminalLaunch({ launchProcess: launch.launchProcess,
        nativeSignIn: parsed.data.launch?.kind === 'agent_login', context, requesterAccountId: requesterIdentity.requester.accountId,
        sessionId, terminalKey: parsed.data.terminalKey, actionId: 'machines.terminal.open' });
      if (requesterIdentity.kind !== 'owner_person' && placement !== 'daemon') {
        if (!context) return unavailableIdentityTransport();
        nativeOperation = await prepareTerminalNativeOperation(context, requesterIdentity, parsed.data.terminalKey, sessionId);
        if (!nativeOperation || placement === 'member' && !nativeOperation.memberIdentity) {
          await nativeOperation?.dispose(); return unavailableIdentityTransport();
        }
      }
      const preparation = projectCustody && !warm
        ? await prepareProjectShell(projectCustody, launch.launchProcess, context, requesterIdentity, nativeOperation)
        : nativeOperation && context ? await prepareNativeShell(cwd.cwd, launch.launchProcess, context, requesterIdentity, nativeOperation) : undefined;
      if (preparation && !preparation.ok) { await nativeOperation?.dispose(); return preparation; }
      if (preparation) prepared = { ...preparation, release: async () => {
        try { await preparation.release(); } finally { await nativeOperation?.dispose(); }
      } };
    } catch (error) {
      await nativeOperation?.dispose();
      if (isPluginError(error)) return { ok: false as const, ...normalizeActionExecutorThrownError(error) };
      return unavailableIdentityTransport();
    }
    if (!context || context.signal.aborted) {
      if (prepared) void prepared.release().catch(observeShellReleaseFailure);
      return err('terminal_forbidden');
    }
    const result = await getSessionManager().ensure({
      ...(params.deps?.admissionDrain ? { admissionDrain: params.deps.admissionDrain } : {}),
      terminalKey: parsed.data.terminalKey,
      cwd: cwd.cwd,
      ...('custody' in cwd && cwd.custody ? { custody: { ...cwd.custody,
        ...(homeServerIdentityId ? { homeServerIdentityId } : {}) } } : {}),
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      ...(launch.launchProcess ? { launchProcess: launch.launchProcess } : {}),
      ...(prepared ? { authorizedProjectLaunch: prepared.authorizedProjectLaunch } : {}),
      ...(nativeOperation?.memberIdentity ? { nativeExecutionIdentity: nativeOperation.memberIdentity } : {}),
      ...(sessionId ? { sessionId } : {}),
      signal: context.signal,
    });
    return prepared ? retainShellLaunch(prepared, result) : result;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return err('terminal_forbidden');

    return getSessionManager().read({
      terminalId: parsed.data.terminalId,
      cursor: parsed.data.cursor,
      maxBytes: parsed.data.maxBytes ?? config.readDefaults.maxBytes,
      maxEvents: parsed.data.maxEvents ?? config.readDefaults.maxEvents,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, async (raw: unknown, context) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();
    if (!await authorizeTerminal(parsed.data.terminalId, context,
      isFiniteOutputRead(parsed.data.terminalId) ? 'finite_output' : 'control')) return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };

    const manager = getSessionManager();
    if (typeof manager.readByteStream !== 'function') {
      return terminalStreamUnavailable();
    }
    const { holdForOutput, ...request } = parsed.data;
    const canHold = holdForOutput === true && context?.machineAdmission && manager.waitForByteStreamChange;
    let response: TerminalStreamReadResponse;
    // Machine admission owns access-loss retirement. An unbounded RPC keeps
    // that same cancellable lifetime instead of manufacturing an idle deadline.
    if (canHold && context) {
      const retirement = new AbortController();
      const reader = { terminalId: request.terminalId, retire: () => retirement.abort() };
      heldByteStreamReaders.add(reader);
      try {
        const held = await readByteStreamHeld(manager, request, { signal: AbortSignal.any([context.signal, retirement.signal]),
          ...(context.deadlineAtMs === undefined ? {} : { endsAtMs: byteStreamHoldEndsAtMs(context.deadlineAtMs) }) });
        if (held === 'aborted') return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };
        response = held;
      } finally { heldByteStreamReaders.delete(reader); }
    } else {
      response = manager.readByteStream(request);
    }
    // Older strict clients never opted in, so their response shape is unchanged.
    return TerminalStreamReadResponseSchema.parse(response.ok && canHold ? { ...response, holdForOutput: true } : response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK, async (raw: unknown, context) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamAckRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };

    const manager = getSessionManager();
    if (typeof manager.acknowledgeByteStream !== 'function') {
      return terminalStreamUnavailable();
    }
    const response = await manager.acknowledgeByteStream(parsed.data);
    return TerminalStreamAckResponseSchema.parse(response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, async (raw: unknown, context) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamInputRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();
    const manager = getSessionManager();
    if (typeof manager.inputEvent !== 'function') {
      return terminalStreamUnavailable();
    }
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };
    const response = await manager.inputEvent(parsed.data, {
      signal: context?.signal,
    });
    return TerminalStreamInputResponseSchema.parse(response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_INPUT, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalInputRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return err('terminal_forbidden');
    return getSessionManager().input(parsed.data, {
      signal: context?.signal,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESIZE, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalResizeRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return err('terminal_forbidden');
    return getSessionManager().resize(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_CLOSE, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalCloseRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (!await authorizeTerminal(parsed.data.terminalId, context, 'retire')) return err('terminal_forbidden');
    if (getSessionManager().isFiniteHeld(parsed.data.terminalId)) return err('terminal_busy');
    return getSessionManager().getCustody(parsed.data.terminalId) || params.deps?.requiredSessionId
      ? await settleTerminalClose(parsed.data.terminalId, context?.signal)
      : getSessionManager().close(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESTART, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalRestartRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (
      params.deps?.requiredSessionId
      && (
        (parsed.data.sessionId !== undefined && parsed.data.sessionId !== params.deps.requiredSessionId)
        || (parsed.data.launch?.kind === 'session_attach' && parsed.data.launch.sessionId !== params.deps.requiredSessionId)
      )
    ) return err('terminal_invalid_request');

    if (parsed.data.launch?.kind === 'package_script') {
      const cwd = resolveCwd(parsed.data.cwd);
      return cwd.ok ? await runPackageScript(cwd.cwd, parsed.data.launch.runTargetId, context) : cwd;
    }
    const resolvedRequester = await resolveRequesterIdentity(context);
    const { identity: requesterIdentity, homeServerIdentityId } = resolvedRequester;
    const placement = resolveTerminalPlacement(requesterIdentity, context);
    if (requesterIdentity.kind === 'unknown') return unavailableIdentityTransport(resolvedRequester.cause);
    if (parsed.data.launch?.kind === 'service_shell') {
      if (requesterIdentity.kind === 'isolated' && requesterIdentity.separationRequired) return unavailableIdentityTransport();
      return await runServiceShell({ ...parsed.data, launch: parsed.data.launch }, context, 'machines.terminal.restart', homeServerIdentityId);
    }
    if (requesterIdentity.kind !== 'owner_person'
      && placement !== 'daemon' && !params.deps?.nativeOperationRuntime) return unavailableIdentityTransport();

    const cwd = await resolveTerminalCustody(parsed.data, context, requesterIdentity);
    if (!cwd.ok) return cwd;
    if (params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
    const launch = await resolveRequestedLaunch(parsed.data.launch);
    if (!launch.ok) return launch;
    const sessionId = params.deps?.requiredSessionId ?? parsed.data.sessionId
      ?? ('custody' in cwd && cwd.custody?.kind === 'session' ? cwd.custody.sessionId : undefined);

    const projectCustody = 'custody' in cwd && cwd.custody?.kind === undefined ? cwd.custody : undefined;
    let nativeOperation: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>> | undefined;
    let prepared: Extract<Awaited<ReturnType<typeof prepareProjectShell>>, { ok: true }> | undefined;
    try {
      launch.launchProcess = await prepareAssociatedTerminalLaunch({ launchProcess: launch.launchProcess,
        nativeSignIn: parsed.data.launch?.kind === 'agent_login', context, requesterAccountId: requesterIdentity.requester.accountId,
        sessionId, terminalKey: parsed.data.terminalKey, actionId: 'machines.terminal.restart' });
      if (requesterIdentity.kind !== 'owner_person' && placement !== 'daemon') {
        if (!context) return unavailableIdentityTransport();
        nativeOperation = await prepareTerminalNativeOperation(context, requesterIdentity, parsed.data.terminalKey, sessionId);
        if (!nativeOperation || placement === 'member' && !nativeOperation.memberIdentity) {
          await nativeOperation?.dispose(); return unavailableIdentityTransport();
        }
      }
      const preparation = projectCustody
        ? await prepareProjectShell(projectCustody, launch.launchProcess, context, requesterIdentity, nativeOperation)
        : nativeOperation && context ? await prepareNativeShell(cwd.cwd, launch.launchProcess, context, requesterIdentity, nativeOperation) : undefined;
      if (preparation && !preparation.ok) { await nativeOperation?.dispose(); return preparation; }
      if (preparation) prepared = { ...preparation, release: async () => {
        try { await preparation.release(); } finally { await nativeOperation?.dispose(); }
      } };
    } catch (error) {
      await nativeOperation?.dispose();
      if (isPluginError(error)) return { ok: false as const, ...normalizeActionExecutorThrownError(error) };
      return unavailableIdentityTransport();
    }
    let handedOff = false;
    try {
      let restartCwd = cwd;
      if ('custody' in cwd && cwd.custody) {
        const custody = cwd.custody;
        const existing = getSessionManager().list().find(terminal => {
          const known = getSessionManager().getCustody(terminal.terminalId);
          if (terminal.terminalKey !== parsed.data.terminalKey || terminal.sessionId !== sessionId) return false;
          // The current authenticated Session owner/root read also permits
          // restarting its retained, unstamped Session shell. Standalone records
          // have no such resource witness and remain unattributable.
          if (!known) return custody.kind === 'session' && terminal.sessionId === custody.sessionId && terminal.cwd === cwd.cwd;
          return sameTerminalCustody(known, custody);
        });
        if (existing) {
          if (getSessionManager().getCustody(existing.terminalId) && !await authorizeTerminal(existing.terminalId, context)) return err('terminal_forbidden');
          if (getSessionManager().isFiniteHeld(existing.terminalId)) return err('terminal_busy');
          if (params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
          const settled = await settleTerminalClose(existing.terminalId, context?.signal);
          if (!settled.ok) return settled;
          const current = await resolveTerminalCustody(parsed.data, context);
          if (!current.ok) return current;
          restartCwd = current;
        }
      } else if (params.deps?.requiredSessionId) {
        const existing = getSessionManager().list().find(terminal => terminal.terminalKey === parsed.data.terminalKey
          && terminal.sessionId === params.deps!.requiredSessionId);
        if (existing) {
          if (!await authorizeTerminal(existing.terminalId, context)) return err('terminal_forbidden');
          if (getSessionManager().isFiniteHeld(existing.terminalId)) return err('terminal_busy');
          if (params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
          const settled = await settleTerminalClose(existing.terminalId, context?.signal);
          if (!settled.ok) return settled;
          const current = await resolveTerminalCustody(parsed.data, context);
          if (!current.ok) return current;
          restartCwd = current;
        }
      }

      // Observed Stop may have taken arbitrarily long. Revalidate the accepted
      // checkout and reviewed setup effect before consuming the finalized tuple.
      await prepared?.validate();
      if (!context || context.signal.aborted) return err('terminal_forbidden');
      const result = await getSessionManager().restart({
        signal: context.signal,
        ...(params.deps?.admissionDrain ? { admissionDrain: params.deps.admissionDrain } : {}),
        terminalKey: parsed.data.terminalKey,
        cwd: restartCwd.cwd,
        ...('custody' in restartCwd && restartCwd.custody ? { custody: { ...restartCwd.custody,
          ...(homeServerIdentityId ? { homeServerIdentityId } : {}) } } : {}),
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        ...(launch.launchProcess ? { launchProcess: launch.launchProcess } : {}),
        ...(prepared ? { authorizedProjectLaunch: prepared.authorizedProjectLaunch } : {}),
        ...(nativeOperation?.memberIdentity ? { nativeExecutionIdentity: nativeOperation.memberIdentity } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      handedOff = true;
      return prepared ? retainShellLaunch(prepared, result) : result;
    } catch (error) {
      return { ...err('terminal_invalid_request'), error: context?.signal.aborted ? 'cancelled'
        : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_preparation_unavailable',
        ...(error instanceof Error && 'details' in error ? { details: error.details } : {}) };
    } finally {
      if (prepared && !handedOff) void prepared.release().catch(observeShellReleaseFailure);
    }
  });

  return {
    getSessionManager,
    cleanupRequesterMachineTerminals: async (input) => {
      // Selection comes only from the actual PTY owner. Unknown predecessor
      // attribution is not inferred from cwd, key spelling or caller payload.
      const terminals = sessionManager?.list() ?? [];
      let incomplete = terminals.some(terminal => !sessionManager?.getCustody(terminal.terminalId));
      // Start every selected stop and viewer retirement before waiting for any
      // process exit; one slow shell cannot prolong the requester's other shells.
      await Promise.all(terminals.map(async terminal => {
        const custody = sessionManager?.getCustody(terminal.terminalId);
        if (!custody || custody.serverId !== input.serverId || custody.requesterAccountId !== input.requesterAccountId
          || custody.machineId !== input.machineId || custody.installationId !== input.installationId) return;
        if (input.remainingRole === 'use' && custody.kind !== 'machine') return;
        for (const reader of heldByteStreamReaders) if (reader.terminalId === terminal.terminalId) reader.retire();
        // Admitted finite work finishes naturally; its output view does not
        // promote presentation cleanup into task cancellation.
        if (sessionManager?.isFiniteHeld(terminal.terminalId)) return;
        try {
          if (input.signal.aborted || !input.isCurrentInstallation()
            || sessionManager?.getCustody(terminal.terminalId) !== custody) {
            incomplete = true;
            return;
          }
          const settled = await settleTerminalClose(terminal.terminalId);
          if (!settled.ok) incomplete = true;
        } catch { incomplete = true; }
      }));
      return { kind: incomplete ? 'incomplete' : 'settled' };
    },
    dispose: () => {
      sessionManager?.dispose();
      sessionManager = null;
    },
  };
}
