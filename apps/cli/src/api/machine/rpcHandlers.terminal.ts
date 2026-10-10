import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonTerminalCloseRequestSchema, DaemonTerminalEnsureRequestSchema, DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema, DaemonTerminalInputRequestSchema, DaemonTerminalResizeRequestSchema, DaemonTerminalRestartRequestSchema, DaemonTerminalStreamReadRequestSchema } from '@happier-dev/protocol/daemon/terminal';
import { TerminalStreamAckRequestSchema, TerminalStreamAckResponseSchema, TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { TerminalStreamInputRequestSchema, TerminalStreamInputResponseSchema } from '@happier-dev/protocol/terminal/input';
import type { DaemonTerminalErrorCode, TerminalStreamAckRequest, TerminalStreamAckResponse, TerminalStreamInputRequest, TerminalStreamInputResponse, TerminalStreamReadRequest, TerminalStreamReadResponse } from '@happier-dev/protocol';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { normalizeWorkspaceRootPathV1, projectWorkspaceRefV1, resolveWorkspaceRefV1, workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { StoredCredentials } from '@/persistence';
import { hostname } from 'node:os';
import { logger } from '@/ui/logger';
import { readOwnSessionMachineWorkspace } from '@/session/machineControlLocality';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectRuntimeAccountAccess } from '@/workspaces/projectAccountRows';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { dispatchActionFromRpc, type RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';
import {
  resolveFilesystemAccessPolicy,
  type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createTerminalPtySessionManager, type TerminalPtySessionManager, type TerminalPtyCustody } from '@/terminal/pty/sessions';
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
type ProjectTerminalRuntime = ProjectFiniteActionRuntime & Readonly<{
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
    verifyCurrentMachineAdmission: () => Promise<boolean>;
  }>) => Promise<Readonly<{ kind: 'settled' | 'incomplete' }>>;
  dispose: () => void;
}>;

export type MachineTerminalRpcHandlerDeps = Readonly<{
  /** Captured Home of the installed Machine RPC owner, not a request field. */
  serverId?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  workingDirectory?: string;
  accessPolicy?: FilesystemAccessPolicy;
  sessionManager?: TerminalBridgeSessionManager;
  terminalRegistry?: TerminalProcessRegistry;
  admissionDrain?: DaemonAdmissionDrain;
  resolveLaunch?: (launch: import('@happier-dev/protocol').DaemonTerminalLaunchIntent) => TerminalLaunchProcess;
  projectFiniteRuntime?: (ingress: RpcHandlerContext) => ProjectTerminalRuntime | null | Promise<ProjectTerminalRuntime | null>;
  ownSessionRuntime?: (ingress: RpcHandlerContext) => MachineTerminalOwnSessionReadRuntime | null | Promise<MachineTerminalOwnSessionReadRuntime | null>;
  /** The real receiving Action executor owns invocation policy, consent and finite launch. */
  projectScriptExecutor?: (runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext) => RpcActionExecutor | Promise<RpcActionExecutor>;
  /**
   * Narrows the canonical terminal owner to one Session-scoped Machine runtime.
   * Omitted attribution is stamped with this value; an explicit sibling Session
   * is rejected before a terminal is opened.
   */
  requiredSessionId?: string;
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
  const { rpcHandlerManager } = params;
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
  const resolveRequestedLaunch = (launch: Exclude<import('@happier-dev/protocol').DaemonTerminalLaunchIntent, { kind: 'package_script' }> | undefined) => {
    try {
      return { ok: true as const, launchProcess: launch ? resolveLaunch(launch) : undefined };
    } catch (error) {
      return err(error instanceof AgentLoginLaunchError ? error.code : 'terminal_spawn_failed');
    }
  };

  let sessionManager: TerminalBridgeSessionManager | null = params.deps?.sessionManager ?? null;
  const getSessionManager = (): TerminalBridgeSessionManager => {
    if (sessionManager) return sessionManager;
    sessionManager = createTerminalPtySessionManager({
      ptyProvider: createNodePtyProvider(),
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

  const admissionCurrent = async (context: RpcHandlerContext): Promise<boolean> => {
    try { return !context.signal.aborted && !!context.verifyMachineAdmissionCurrent
      && await context.verifyMachineAdmissionCurrent() && !context.signal.aborted; }
    catch { return false; }
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
    if (!admission || !await admissionCurrent(context)) return err('terminal_forbidden');
    const runtime = await params.deps?.ownSessionRuntime?.(context);
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
      if (!await admissionCurrent(context)) return err('terminal_forbidden');
      if (runtime.isCurrent && !await runtime.isCurrent()) return err('terminal_forbidden');
      return { ok: true, cwd: root.cwd, custody: { kind: 'session', serverId: runtime.serverId,
        requesterAccountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId,
        sessionId, rootPath: root.cwd } };
    } catch { return err('terminal_forbidden'); }
  };

  const resolveTerminalCustody = async (input: Readonly<{ workspace?: WorkspaceAddressV1; cwd?: string; sessionId?: string; launch?: import('@happier-dev/protocol').DaemonTerminalLaunchIntent }>, context?: RpcHandlerContext)
    : Promise<Readonly<{ ok: true; cwd: string; custody?: TerminalPtyCustody }> | ReturnType<typeof err>> => {
    if (hasRequiredSessionAuthority(context)) {
      if (input.workspace) return err('terminal_invalid_request');
      if (context?.machineAdmission && !await admissionCurrent(context)) return err('terminal_forbidden');
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
    if (!await admissionCurrent(context)) return err('terminal_forbidden');
    const admission = context.machineAdmission;
    const runtime = await params.deps?.projectFiniteRuntime?.(context);
    // The requester Account owner must supply its own ports. Machine Use never
    // authorizes reading the custodian's private accepted-workspace catalog.
    if (!runtime || runtime.accountId !== admission.actorAccountId) return err('terminal_unavailable');
    if (runtime.machineId !== admission.machineId || params.deps?.serverId !== undefined && runtime.serverId !== params.deps.serverId) return err('terminal_forbidden');
    if (input.workspace && (input.workspace.serverId !== runtime.serverId || input.workspace.machineId !== runtime.machineId)) return err('terminal_cwd_denied');
    try {
      if (runtime.isCurrent && !await runtime.isCurrent()) return err('terminal_forbidden');
      const rows = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => readProjectAccountRows({
        ...projectRuntimeAccountRowsInput(runtime, context.callerInputAuthorization?.binding.actionId ?? 'machines.terminal.open'), serverId: runtime.serverId, signal: context.signal,
      }));
      const cwd = resolveCwd(input.workspace?.rootPath ?? input.cwd);
      if (!cwd.ok) return cwd;
      if (input.workspace && input.cwd !== undefined) {
        const requested = resolveCwd(input.cwd);
        if (!requested.ok || normalizeWorkspaceRootPathV1(requested.cwd) !== normalizeWorkspaceRootPathV1(cwd.cwd)) return err('terminal_cwd_denied');
      }
      const accepted = resolveWorkspaceRefV1(rows.workspaceRefs, input.workspace ?? {
        serverId: runtime.serverId, machineId: runtime.machineId, rootPath: cwd.cwd,
      });
      if (accepted.kind !== 'resolved') return err('terminal_cwd_denied');
      const acceptedCwd = resolveCwd(accepted.ref.rootPath);
      if (!acceptedCwd.ok || normalizeWorkspaceRootPathV1(acceptedCwd.cwd) !== normalizeWorkspaceRootPathV1(cwd.cwd)) return err('terminal_cwd_denied');
      if (!await admissionCurrent(context)) return err('terminal_forbidden');
      if (runtime.isCurrent && !await runtime.isCurrent()) return err('terminal_forbidden');
      return { ok: true, cwd: acceptedCwd.cwd, custody: {
        serverId: runtime.serverId, requesterAccountId: admission.actorAccountId, machineId: admission.machineId,
        installationId: admission.installationId, workspaceRefId: accepted.ref.id,
        projectKey: projectWorkspaceRefV1(accepted.ref).projectKey, rootPath: acceptedCwd.cwd,
      } };
    } catch { return err('terminal_forbidden'); }
  };

  const authorizeTerminal = async (terminalId: string, context?: RpcHandlerContext): Promise<boolean> => {
    const manager = getSessionManager();
    const custody = manager.getCustody(terminalId);
    const terminal = manager.list().find(candidate => candidate.terminalId === terminalId);
    if (!terminal) return !context?.machineAdmission && !params.deps?.requiredSessionId;
    if (params.deps?.requiredSessionId && terminal.sessionId !== params.deps.requiredSessionId) return false;
    if (hasRequiredSessionAuthority(context)) return !context?.machineAdmission || await admissionCurrent(context);
    if (!context?.machineAdmission) return custody === null;
    const admission = context.machineAdmission;
    if (!custody || custody.requesterAccountId !== admission.actorAccountId || custody.machineId !== admission.machineId
      || custody.installationId !== admission.installationId) return false;
    if (custody.kind === 'machine') return custody.serverId === params.deps?.serverId && await admissionCurrent(context);
    if (custody.kind === 'session') {
      if (terminal.sessionId !== custody.sessionId) return false;
      const current = await resolveOwnSessionCustody(custody.sessionId, custody.rootPath, context);
      return current.ok && current.custody.serverId === custody.serverId;
    }
    if (terminal.sessionId && terminal.sessionId !== params.deps?.requiredSessionId
      && terminal.sessionId !== context.sessionActionOrigin?.caller.sessionId) return false;
    const current = await resolveTerminalCustody({ workspace: {
      serverId: custody.serverId, workspaceId: custody.workspaceRefId, machineId: custody.machineId, rootPath: custody.rootPath,
    } }, context);
    return current.ok && current.custody?.kind === undefined && current.custody?.projectKey === custody.projectKey;
  };

  const settleTerminalClose = async (terminalId: string, signal?: AbortSignal) => {
    const manager = getSessionManager();
    const requested = await manager.requestStop({ terminalId });
    if (requested.kind === 'unconfirmed' || requested.kind === 'unavailable') return err('terminal_busy');
    if (requested.kind === 'requested') {
      const settled = await manager.waitForExit({ terminalId, ...(signal ? { signal } : {}) });
      if (settled.kind !== 'exited') return err('terminal_busy');
    }
    return manager.close({ terminalId });
  };

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
      localActionContext: { ...context.localActionContext, surface: context.localActionContext?.surface ?? 'api',
        actionRequestId: context.localActionContext?.actionRequestId ?? context.sessionActionOrigin?.requestId ?? context.transportRequestId },
    });
  };
  const observeShellReleaseFailure = () => logger.debug('[terminal] Project shell native resources remain unsettled');

  /** Fresh Project shells consume B9 preparation and B4's final tuple, not a new setup runner. */
  const prepareProjectShell = async (custody: Extract<TerminalPtyCustody, { kind?: undefined }>,
    launchProcess: TerminalLaunchProcess | undefined, context: RpcHandlerContext | undefined) => {
    const refused = (code: string, details?: unknown) => ({ ...err('terminal_invalid_request'), error: code,
      ...(details === undefined ? {} : { details }) });
    if (!context?.machineAdmission) return refused('machine_admission_required');
    let release: (() => Promise<void>) | undefined;
    try {
      const runtime = await params.deps?.projectFiniteRuntime?.(context);
      if (!runtime || runtime.accountId !== custody.requesterAccountId || runtime.machineId !== custody.machineId
        || runtime.serverId !== custody.serverId) return refused('project_requester_credentials_unavailable');
      if (runtime.terminalSessions !== getSessionManager()) return refused('project_terminal_owner_mismatch');
      const [{ resolveProjectSetupAcceptedWorkspace }, { prepareProjectSetup },
        { createProjectNativeInvocationCustody, createProjectNativeLaunchAdmission }, { authorizeResolvedProjectExecLaunchForHost }] = await Promise.all([
        import('@/workspaces/projectSetup/projectSetupAcceptedWorkspace'), import('@/workspaces/projectSetup/projectSetupPreparation'),
        import('@/workspaces/projectSetup/projectSetupExecution'), import('@/plugins/runtime/invocation/services/exec'),
      ]);
      const assertCurrent = async () => {
        if (!await admissionCurrent(context) || runtime.isCurrent && !await runtime.isCurrent()) {
          throw Object.assign(new Error('machine_admission_changed'), { code: 'machine_admission_changed' });
        }
      };
      await assertCurrent();
      const accountAccess = projectRuntimeAccountRowsInput(runtime, context.callerInputAuthorization?.binding.actionId ?? 'machines.terminal.open');
      const association = await resolveProjectSetupAcceptedWorkspace({ ...accountAccess,
        serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal,
        address: { serverId: custody.serverId, workspaceId: custody.workspaceRefId, machineId: custody.machineId, rootPath: custody.rootPath } });
      if (association.workspace.projectKey !== custody.projectKey) return refused('project_workspace_changed');
      const nativeCustody = createProjectNativeInvocationCustody({ signal: context.signal });
      let authorized: Awaited<ReturnType<typeof authorizeResolvedProjectExecLaunchForHost>> | undefined;
      release = async () => {
        try { await authorized?.release(); }
        finally {
          try { await nativeCustody.release(); }
          finally { nativeCustody.dispose(); }
        }
      };
      const platform = runtime.platform ?? params.deps?.platform ?? process.platform;
      const preparation = { workspace: association.workspace, projectAssociation: association,
        requester: { ...accountAccess, serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup' as const,
        platform: { os: platform === 'win32' ? 'windows' : platform, arch: runtime.arch ?? process.arch },
        nativeIo: runtime.nativeIo, signal: context.signal, retainNativeInvocation: nativeCustody.retain,
        ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
        ...(runtime.secretEnvironment ? { secretEnvironment: runtime.secretEnvironment } : {}),
        ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
        ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
      };
      const inspect = async () => {
        await assertCurrent();
        const current = await resolveProjectSetupAcceptedWorkspace({ ...accountAccess,
          serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal,
          address: workspaceAddressFromRefV1(association.workspace) });
        if (current.workspace.projectKey !== custody.projectKey) throw Object.assign(new Error('project_workspace_changed'), { code: 'project_workspace_changed' });
        const outcome = await prepareProjectSetup(preparation);
        await assertCurrent();
        if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.code), { code: outcome.code });
        if (outcome.kind === 'pendingApproval') throw Object.assign(new Error(outcome.code), { code: outcome.code,
          details: { kind: outcome.kind, code: outcome.code, reviewedEffect: outcome.plan.reviewedEffect, reviewedEffectDigest: outcome.plan.reviewedEffectDigest } });
        return outcome;
      };
      let prepared = await inspect();
      if (prepared.kind === 'prepared' && !prepared.previousSuccess) {
        const result = await dispatchProjectAction(runtime, context, 'projects.prepare', {
          workspace: workspaceAddressFromRefV1(association.workspace), phase: 'setup', expectedEffectDigest: prepared.plan.reviewedEffectDigest,
        });
        if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode, details: result.details });
        const output = ProjectCommandActionOutputV1Schema.safeParse(result.result);
        if (!output.success) throw Object.assign(new Error('project_setup_pending'), { code: 'project_setup_pending' });
        const operation = await runtime.operationRuntime.runner.waitForTerminal(
          { accountId: runtime.accountId, machineId: runtime.machineId }, output.data.operation.operationId, context.signal);
        if (!operation || operation.state !== 'succeeded' || operation.observation?.kind === 'outcome_uncertain') {
          const code = operation?.error?.errorCode ?? operation?.observation?.code ?? (operation?.state === 'cancelled' ? 'cancelled' : 'project_setup_pending');
          throw Object.assign(new Error(code), { code });
        }
        const current = await inspect();
        if (current.plan.reviewedEffectDigest !== prepared.plan.reviewedEffectDigest
          || current.kind === 'prepared' && !current.previousSuccess) throw Object.assign(new Error('project_setup_effect_changed'), { code: 'project_setup_effect_changed' });
        prepared = current;
      }
      const plan = prepared.plan;
      const base = launchProcess ?? resolveTerminalShell(runtime.hostEnvironment ?? env, platform);
      const hostEnvironment: NodeJS.ProcessEnv = { ...(runtime.hostEnvironment ?? env), ...('env' in base ? base.env : {}), ...plan.configEnvironment };
      const launchEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(hostEnvironment)) if (value !== undefined) launchEnv[key] = value;
      const projectLaunch = createProjectNativeLaunchAdmission({ preparation, hostEnvironment, platform,
        environmentIo: runtime.environmentIo, operation: { signal: context.signal } }, plan);
      authorized = await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: base.file, args: base.args, cwd: association.workspace.rootPath, env: launchEnv }, projectLaunch, signal: context.signal,
        assertCurrent() {
          if (context.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          if (plan.environmentAdapterLease && !plan.environmentAdapterLease.isCurrent()) throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
        }, ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}),
      });
      const validate = async () => {
        const current = await inspect();
        if (current.plan.reviewedEffectDigest !== plan.reviewedEffectDigest
          || current.kind === 'prepared' && !current.previousSuccess) throw Object.assign(new Error('project_setup_effect_changed'), { code: 'project_setup_effect_changed' });
      };
      await validate();
      return { ok: true as const, authorizedProjectLaunch: authorized,
        validate, release };
    } catch (error) {
      // The capture owner waits for physical settlement without holding the caller's
      // observation open or interpreting uncertainty as permission to spawn.
      if (release) void release().catch(observeShellReleaseFailure);
      const code = context.signal.aborted ? 'cancelled'
        : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_preparation_unavailable';
      return refused(code, error instanceof Error && 'details' in error ? error.details : undefined);
    }
  };

  const retainShellLaunch = (prepared: Extract<Awaited<ReturnType<typeof prepareProjectShell>>, { ok: true }>,
    result: ReturnType<TerminalPtySessionManager['ensure']>) => {
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
    if (!context || !admission || !context.verifyMachineAdmissionCurrent) return refused('machine_admission_required');
    const isCurrent = async () => !context.signal.aborted && await context.verifyMachineAdmissionCurrent!() && !context.signal.aborted;
    try {
      if (!await isCurrent()) return refused('machine_admission_changed');
      const runtime = await params.deps?.projectFiniteRuntime?.(context);
      if (!runtime || !params.deps?.projectScriptExecutor) return refused('project_finite_execution_unavailable');
      if (admission.machineId !== runtime.machineId) return refused('target_mismatch');
      if (admission.actorAccountId !== runtime.accountId || admission.custodianAccountId !== runtime.accountId) {
        return refused('project_requester_credentials_unavailable');
      }
      const rows = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => readProjectAccountRows({
        ...projectRuntimeAccountRowsInput(runtime, 'projects.script.run'), serverId: runtime.serverId, signal: context.signal,
      }));
      if (!await isCurrent()) return refused('machine_admission_changed');
      // Directory selects only an exact accepted checkout. Its stored Project anchor,
      // never an inferred enclosing root, supplies preparation/trust association.
      const accepted = resolveWorkspaceRefV1(rows.workspaceRefs, { serverId: runtime.serverId, machineId: runtime.machineId, rootPath: cwd });
      if (accepted.kind !== 'resolved' || !accepted.ref.projectKey) return refused('project_workspace_unavailable');
      const targets = await discoverLocalServiceRunTargets({ roots: [accepted.ref.rootPath] });
      if (!await isCurrent()) return refused('machine_admission_changed');
      const target = targets.find(candidate => candidate.id === runTargetId && candidate.cwd === accepted.ref.rootPath);
      if (!target) return refused('native_target_missing');
      // The receiving producer must borrow the incumbent PTY, including its rings and holds.
      if (runtime.terminalSessions !== getSessionManager()) return refused('project_terminal_owner_mismatch');
      const result = await dispatchProjectAction(runtime, context, 'projects.script.run',
        { workspace: workspaceAddressFromRefV1(accepted.ref), selection: { kind: 'native', source: {
          kind: 'native', tool: 'package_script', file: 'package.json', target: target.scriptName,
        } } });
      if (!result.ok) return refused(result.errorCode, result.details);
      const output = ProjectCommandActionOutputV1Schema.safeParse(result.result);
      if (!output.success) return refused('project_script_pending', result.result);
      const operation = await runtime.operationRuntime.waitForProjectTerminalAttachment(
        { accountId: admission.actorAccountId, machineId: runtime.machineId }, output.data.operation.operationId, context.signal,
      );
      if (!await isCurrent()) return refused('machine_admission_changed');
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
    if (context?.machineAdmission && !await admissionCurrent(context)) return err('terminal_forbidden');
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
      if (await authorizeTerminal(terminal.terminalId, context)) terminals.push(terminal);
    }
    if (context?.machineAdmission && !await admissionCurrent(context)) return err('terminal_forbidden');
    return DaemonTerminalListResponseV1Schema.parse({
      ok: true,
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

    const cwd = parsed.data.launch?.kind === 'package_script' ? resolveCwd(parsed.data.cwd)
      : await resolveTerminalCustody(parsed.data, context);
    if (!cwd.ok) return cwd;
    if (parsed.data.launch?.kind === 'package_script') return await runPackageScript(cwd.cwd, parsed.data.launch.runTargetId, context);
    const launch = resolveRequestedLaunch(parsed.data.launch);
    if (!launch.ok) return launch;
    const sessionId = params.deps?.requiredSessionId ?? parsed.data.sessionId
      ?? ('custody' in cwd && cwd.custody?.kind === 'session' ? cwd.custody.sessionId : undefined);
    const projectCustody = 'custody' in cwd && cwd.custody?.kind === undefined ? cwd.custody : undefined;
    const warm = projectCustody && getSessionManager().list().some(terminal => !terminal.ended
      && terminal.terminalKey === parsed.data.terminalKey && terminal.sessionId === sessionId
      && sameTerminalCustody(getSessionManager().getCustody(terminal.terminalId), projectCustody));
    if (projectCustody && !warm && params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
    const prepared = projectCustody && !warm ? await prepareProjectShell(projectCustody, launch.launchProcess, context) : undefined;
    if (prepared && !prepared.ok) return prepared;
    const result = getSessionManager().ensure({
      ...(params.deps?.admissionDrain ? { admissionDrain: params.deps.admissionDrain } : {}),
      terminalKey: parsed.data.terminalKey,
      cwd: cwd.cwd,
      ...('custody' in cwd && cwd.custody ? { custody: cwd.custody } : {}),
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      initialCommand: parsed.data.initialCommand,
      ...(launch.launchProcess ? { launchProcess: launch.launchProcess } : {}),
      ...(prepared ? { authorizedProjectLaunch: prepared.authorizedProjectLaunch } : {}),
      ...(sessionId ? { sessionId } : {}),
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
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };

    const manager = getSessionManager();
    if (typeof manager.readByteStream !== 'function') {
      return terminalStreamUnavailable();
    }
    const response = await manager.readByteStream(parsed.data);
    return TerminalStreamReadResponseSchema.parse(response);
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
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return { ok: false, code: 'terminal_forbidden', message: 'terminal_forbidden' };

    const manager = getSessionManager();
    if (typeof manager.inputEvent !== 'function') {
      return terminalStreamUnavailable();
    }
    const response = await manager.inputEvent(parsed.data);
    return TerminalStreamInputResponseSchema.parse(response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_INPUT, async (raw: unknown, context) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalInputRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return err('terminal_forbidden');
    return getSessionManager().input(parsed.data);
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
    if (!await authorizeTerminal(parsed.data.terminalId, context)) return err('terminal_forbidden');
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

    const cwd = parsed.data.launch?.kind === 'package_script' ? resolveCwd(parsed.data.cwd)
      : await resolveTerminalCustody(parsed.data, context);
    if (!cwd.ok) return cwd;
    if (parsed.data.launch?.kind === 'package_script') return await runPackageScript(cwd.cwd, parsed.data.launch.runTargetId, context);
    if (params.deps?.admissionDrain?.isQuiescing()) return err('terminal_busy');
    const launch = resolveRequestedLaunch(parsed.data.launch);
    if (!launch.ok) return launch;
    const sessionId = params.deps?.requiredSessionId ?? parsed.data.sessionId
      ?? ('custody' in cwd && cwd.custody?.kind === 'session' ? cwd.custody.sessionId : undefined);

    const projectCustody = 'custody' in cwd && cwd.custody?.kind === undefined ? cwd.custody : undefined;
    const prepared = projectCustody ? await prepareProjectShell(projectCustody, launch.launchProcess, context) : undefined;
    if (prepared && !prepared.ok) return prepared;
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
      const result = getSessionManager().restart({
        ...(params.deps?.admissionDrain ? { admissionDrain: params.deps.admissionDrain } : {}),
        terminalKey: parsed.data.terminalKey,
        cwd: restartCwd.cwd,
        ...('custody' in restartCwd && restartCwd.custody ? { custody: restartCwd.custody } : {}),
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        initialCommand: parsed.data.initialCommand,
        ...(launch.launchProcess ? { launchProcess: launch.launchProcess } : {}),
        ...(prepared ? { authorizedProjectLaunch: prepared.authorizedProjectLaunch } : {}),
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
      for (const terminal of terminals) {
        const custody = sessionManager?.getCustody(terminal.terminalId);
        if (!custody || custody.serverId !== input.serverId || custody.requesterAccountId !== input.requesterAccountId
          || custody.machineId !== input.machineId || custody.installationId !== input.installationId) continue;
        // The finite Action owner cancels and settles its held work. A borrowed
        // output view cannot promote presentation cleanup into task cancellation.
        if (sessionManager?.isFiniteHeld(terminal.terminalId)) continue;
        try {
          if (!await input.verifyCurrentMachineAdmission()) return { kind: 'incomplete' };
          if (sessionManager?.getCustody(terminal.terminalId) !== custody) return { kind: 'incomplete' };
          const settled = await settleTerminalClose(terminal.terminalId);
          if (!settled.ok) incomplete = true;
        } catch { incomplete = true; }
      }
      return { kind: incomplete ? 'incomplete' : 'settled' };
    },
    dispose: () => {
      sessionManager?.dispose();
      sessionManager = null;
    },
  };
}
