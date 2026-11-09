import type { ResolvedSessionTransport } from '../actions/cliActionDeps/types';
import type { CliActionDepsParams, CurrentMachineControlIdentity } from '../actions/cliActionDeps/types';
import { homedir } from 'node:os';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { type SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { resolveSessionRoleRpcOrigin } from '../actions/sessionRoleRpcOrigin';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import type { SessionBridgeLifecycleHookEventIdV1, ActionExecutorContext } from '@happier-dev/protocol';
import { RoleActionRefusalV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { getPreferredHostName } from '@/daemon/machine/metadata';
import type { readSettings } from '@/persistence';
import { createCliBoundSessionMetadataReader } from '../actions/resolveCliActionCallerSession';
import { prepareInstalledWorkflowActionAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { type SessionResumeRequestV1 } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { callSessionRpc, resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode, RpcError } from '@happier-dev/protocol/rpcErrors';
import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import type { CliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
import type { InactiveSessionResumeResult } from '@/session/services/requestInactiveSessionResume';

type LifecycleHookSessionContext = Readonly<{
    machineId?: string;
    cwd?: string;
    workspaceId?: string;
  }>;
export type CliSessionActionTransport = Readonly<{
  readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
  readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
  resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  resumeInactiveSessionTransport: (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    effectActionId: 'execution.run.start' | 'session.open' | 'session.user_action.answer';
    context?: ActionExecutorContext;
    /** Admitted invocation authority when the caller has no Session-Resume context to lend. */
    executionAuthority?: ActionExecutorContext['authority'];
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequest?: SessionResumeRequestV1;
  }>) => Promise<InactiveSessionResumeResult>;
  callSessionRpcForTransport: (transport: ResolvedSessionTransport, methodSuffix: string, request: unknown, signal?: AbortSignal, timeoutMs?: number | null) => Promise<unknown>;
  readSessionActionRpcOrigin: (method: string, context: ActionExecutorContext) => SessionActionRpcOriginV1;
  callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
  dispatchSessionLifecycleHookEvent: (event: Readonly<{
    eventId: SessionBridgeLifecycleHookEventIdV1;
    happySessionId: string;
    backendTarget?: string;
    exactSessionContext?: LifecycleHookSessionContext;
    payload: Record<string, unknown>;
  }>) => Promise<void>;
  callResolvedSessionRpc: (sessionId: string, method: string, request: unknown, signal?: AbortSignal) => Promise<unknown>;
}>;
export function createCliSessionActionTransport(
  params: CliActionDepsParams,
  { callMachineAction, normalizeStringValue, readCurrentSessionMetadata, readServerFeaturesSnapshot, resolveCurrentSessionValue, resolveServerRequestHeaders, withProjectHome }: Readonly<{
    callMachineAction: CliMachineActionCall;
    normalizeStringValue: (value: unknown) => string | null;
    readCurrentSessionMetadata: ReturnType<typeof createCliBoundSessionMetadataReader>;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveCurrentSessionValue: (key: 'path' | 'host' | 'machineId', signal?: AbortSignal) => Promise<string | null>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    withProjectHome: CliProjectAdmission['withProjectHome'];
  }>,
): CliSessionActionTransport {
  const readTransportSessionOwnerMetadata = (transport: ResolvedSessionTransport) => params.credentials
    ? tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession })
    : null;


  let currentMachineControlIdentityPromise: Promise<CurrentMachineControlIdentity> | null = null;

  const readCurrentMachineControlIdentity = async (): Promise<CurrentMachineControlIdentity> => {
    currentMachineControlIdentityPromise ??= (async () => {
      let machineId: string | null = null;
      try {
        const { readSettings } = await import("@/persistence");
        machineId = normalizeStringValue((await readSettings()).machineId);
      } catch {
        machineId = null;
      }

      let host: string | null = null;
      try {
        const { getPreferredHostName } = await import("@/daemon/machine/metadata");
        host = normalizeStringValue(await getPreferredHostName());
      } catch {
        host = null;
      }

      return {
        machineId,
        host,
        homeDir: normalizeStringValue(homedir()),
      };
    })();
    return await currentMachineControlIdentityPromise;
  };

  const resolveTransportForSession = async (idOrPrefix: string, signal?: AbortSignal,
    caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>,
    expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']): Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>> => {
    signal?.throwIfAborted();
    if (!params.credentials) {
      return { ok: false, code: 'not_authenticated' };
    }

    const normalized = String(idOrPrefix ?? '').trim();
    if (!normalized) {
      return { ok: false, code: 'session_not_found' };
    }
    const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
    const credentials = params.credentials;
    const exactSessionAddress = expectedSessionAddress ?? caller?.context.expectedSessionAddress;
    const { resolveSessionTransportContext } = await import('@/session/services/resolveSessionTransportContext');
    const read = () => resolveSessionTransportContext({
      reason: 'session-action',
      credentials,
      idOrPrefix: normalized,
      ...(exactSessionAddress ? { expectedSessionAddress: exactSessionAddress } : {}),
      ...(signal ? { signal } : {}),
      ...(caller ? { resolveAuthorizationHeaders: request => resolveServerRequestHeaders(caller.context,
        // Reference/manager reads prepare the admitted root. A preview's
        // described Action is not a second signed execution authority.
        caller.context.externalActionExecutionAuthorization?.binding.actionId ?? caller.actionId, request) } : {}),
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
    });
    let resolved: Awaited<ReturnType<typeof read>>;
    try {
      resolved = await (caller ? withProjectHome(read) : read());
    } catch (error) {
      signal?.throwIfAborted();
      if (!isAuthenticationError(error)) throw error;
      return { ok: false, code: 'not_authenticated' };
    }
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }

    // A Session can move or lose access between Actions and between capability
    // preflight and admission. Resolve its current transport at each boundary.
    return resolved;
  };

  const resumeInactiveSessionTransport = async (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    effectActionId: 'execution.run.start' | 'session.open' | 'session.user_action.answer';
    context?: ActionExecutorContext;
    /** Admitted invocation authority when the caller has no Session-Resume context to lend. */
    executionAuthority?: ActionExecutorContext['authority'];
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequest?: SessionResumeRequestV1;
  }>) => {
    if (input.effectActionId === 'session.user_action.answer') {
      const metadata = readTransportSessionOwnerMetadata(input.transport);
      const admission = resolveSessionAutoResumeAdmissionV1({ metadata,
        archivedAt: input.transport.rawSession.archivedAt, authorityAvailable: metadata !== null,
        // The existing exact-Machine resume/RPC owners admit reachability next;
        // this lifecycle check must also precede the active-runner shortcut.
        machineAvailable: true,
      });
      if (admission !== 'eligible') return { ok: false,
        code: admission === 'archived' ? 'session_archived' as const
          : admission === 'machine_unavailable' ? 'unsupported' as const : admission,
        message: `Question host is unavailable: ${admission}`,
      } as const;
    }
    if (input.transport.rawSession.active === true && !input.resumeRequest) {
      return { ok: true } as const;
    }
    if (!params.credentials) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Inactive session resume requires authentication',
      } as const;
    }
    const metadata = readTransportSessionOwnerMetadata(input.transport) ?? {};
    const resumeControls = input.resumeRequest ? (() => {
      const { type: _type, sessionId: _sessionId, directory: _directory,
        agentTarget: _agentTarget, backendTarget: _backendTarget,
        executionAuthorization: _executionAuthorization, initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
        spawnNonce: _spawnNonce, initialGoal: _initialGoal,
        approvedNewDirectoryCreation: _approvedNewDirectoryCreation, ...controls } = input.resumeRequest;
      return controls;
    })() : undefined;
    const { requestInactiveSessionResume } = await import("@/session/services/requestInactiveSessionResume");
    return await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId: input.transport.sessionId,
      localId: input.localId,
      rawSession: input.transport.rawSession,
      metadata,
      // Answering may wake its lost host, never clear a person's explicit Stop.
      ...(input.effectActionId === 'session.user_action.answer' ? { executionAuthority: 'account_automation' as const }
        : (input.executionAuthority ?? input.context?.authority) ? { executionAuthority: input.executionAuthority ?? input.context?.authority } : {}),
      ...(input.effectActionId !== 'session.user_action.answer' && input.context ? { actionContext: input.context } : {}),
      ...(resumeControls ? { incomingOptions: resumeControls,
        ...(input.resumeRequest?.initialGoal ? { initialGoal: input.resumeRequest.initialGoal } : {}),
      } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.waitForReady === true ? { waitForReady: true } : {}),
      ...(input.approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}),
      machineRpcTransport: (method, request, options) => callMachineAction({
        machineId: normalizeStringValue(input.transport.rawSession.machineId) ?? normalizeStringValue(metadata.machineId) ?? '',
        method, request, ...options, exactMachine: true, requireCurrentMachine: true,
        ...(input.context ? { context: input.context, authority: input.context.authority } : {}),
        effectActionId: input.effectActionId,
      }),
    });
  };

  const callSessionRpcForTransport = async (
    transport: ResolvedSessionTransport,
    methodSuffix: string,
    request: unknown,
    signal?: AbortSignal,
    timeoutMs?: number | null,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    try {
      const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
      return await callSessionRpc({
        ...transport,
        token: params.credentials.token,
        sessionId: transport.sessionId,
        method: `${transport.sessionId}:${methodSuffix}`,
        request,
        ...(signal ? { signal } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      const errorCode = readRpcErrorCode(error) ?? 'session_rpc_failed';
      return {
        ok: false,
        errorCode,
        error: errorCode,
        errorMessage: error instanceof Error ? error.message : errorCode,
        sessionId: transport.sessionId,
      };
    }
  };

  const readSessionActionRpcOrigin = (method: string, context: ActionExecutorContext): SessionActionRpcOriginV1 => {
    const questionMethod = method === SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE
      || method === 'session.user_action.answer';
    const origin = questionMethod && context.readSessionActionRpcOrigin
      ? context.readSessionActionRpcOrigin()
      : resolveSessionRoleRpcOrigin(context);
    if (!origin) throw new RpcError('role_rpc_origin_unavailable', 'role_rpc_origin_unavailable');
    return origin;
  };

  const callSessionActionRpc = async (
    transport: ResolvedSessionTransport,
    method: string,
    input: unknown,
    context: ActionExecutorContext,
  ): Promise<unknown> => {
    if (context.authority === 'present_user') return await callSessionRpcForTransport(transport, method, input, context.signal);
    if (!params.sessionActionRpcTransport) {
      throw new RpcError('role_rpc_origin_unavailable', 'role_rpc_origin_unavailable');
    }
    context.signal?.throwIfAborted();
    if (context.actionCaller?.kind === 'workflowRun') {
      const caller = context.agentStartContext;
      if (!params.credentials || !params.serverIdentityId || !params.externalActionMachineInstallationId
        || !params.externalActionMachineRequestPrivateKey || !caller || caller.caller.kind !== 'originless') {
        throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
      }
      const authorization = await prepareInstalledWorkflowActionAuthorization({
        credentials: params.credentials, context, input,
        actionId: method,
        target: { kind: 'session', sessionId: transport.sessionId }, machineId: caller.baseline.machineId,
        serverId: params.serverId ?? configuration.activeServerId, serverIdentityId: params.serverIdentityId,
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey,
      });
      if (!authorization) throw new RoleActionRefusalV1('run_access_denied');
      const { resolveSessionRpcContent } = await import("@/session/transport/rpc/sessionRpc");
      return await params.sessionActionRpcTransport({ sessionId: transport.sessionId, method, input,
        content: resolveSessionRpcContent(transport), executionAuthorization: authorization,
        ...(context.signal ? { signal: context.signal } : {}) });
    }
    const origin = readSessionActionRpcOrigin(method, context);
    const { resolveSessionRpcContent } = await import("@/session/transport/rpc/sessionRpc");
    return await params.sessionActionRpcTransport({ sessionId: transport.sessionId, method, input,
      content: resolveSessionRpcContent(transport), origin,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  };

  const normalizeLifecycleHookSessionContext = (context: Readonly<{
    machineId?: unknown;
    cwd?: unknown;
    workspaceId?: unknown;
  }>): LifecycleHookSessionContext => {
    const machineId = normalizeStringValue(context.machineId);
    const cwd = normalizeStringValue(context.cwd);
    const workspaceId = normalizeStringValue(context.workspaceId);
    return {
      ...(machineId ? { machineId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  };

  const resolveLifecycleHookSessionContext = async (event: Readonly<{
    happySessionId: string;
    exactSessionContext?: LifecycleHookSessionContext;
  }>): Promise<LifecycleHookSessionContext> => {
    if (event.exactSessionContext !== undefined) {
      return normalizeLifecycleHookSessionContext(event.exactSessionContext);
    }

    if (event.happySessionId === params.sessionId) {
      const metadata = await readCurrentSessionMetadata();
      return normalizeLifecycleHookSessionContext({
        machineId: await resolveCurrentSessionValue('machineId'),
        cwd: await resolveCurrentSessionValue('path'),
        workspaceId: metadata?.workspaceId,
      });
    }

    try {
      const transport = await resolveTransportForSession(event.happySessionId);
      if (!transport.ok) return {};
      const metadata = readTransportSessionOwnerMetadata(transport);
      return normalizeLifecycleHookSessionContext({
        machineId: normalizeStringValue(transport.rawSession.machineId) ?? metadata?.machineId,
        cwd: normalizeStringValue(transport.rawSession.path) ?? metadata?.path,
        workspaceId: metadata?.workspaceId,
      });
    } catch {
      return {};
    }
  };

  const dispatchSessionLifecycleHookEvent = async (event: Readonly<{
    eventId: SessionBridgeLifecycleHookEventIdV1;
    happySessionId: string;
    backendTarget?: string;
    exactSessionContext?: LifecycleHookSessionContext;
    payload: Record<string, unknown>;
  }>): Promise<void> => {
    const happyHomeDir = typeof params.happyHomeDir === 'string' && params.happyHomeDir.trim().length > 0
      ? params.happyHomeDir.trim()
      : null;
    if (!happyHomeDir) {
      return;
    }
    const sessionContext = await resolveLifecycleHookSessionContext(event);

    const { getSessionHostBridge } = await import("@/agent/runtime/bridges/session/SessionHostBridge");
    await getSessionHostBridge().emitLifecycleHookEvent({
      happyHomeDir,
      eventId: event.eventId,
      happySessionId: event.happySessionId,
      ...sessionContext,
      ...(event.backendTarget ? { backendTarget: event.backendTarget } : {}),
      payload: event.payload,
    });
  };

  const callResolvedSessionRpc = async (
    sessionId: string,
    method: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    // A Session runner already holds this exact host-bound transport, but no
    // Account bearer. Other Sessions still require normal credential resolution.
    if (sessionId === params.sessionId && params.invokeBoundSessionRpc) {
      return await params.invokeBoundSessionRpc(method, request, signal);
    }
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const transport = await resolveTransportForSession(sessionId, signal);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
    }
    return await callSessionRpcForTransport(transport, method, request, signal);
  };
  return { readTransportSessionOwnerMetadata, readCurrentMachineControlIdentity, resolveTransportForSession, resumeInactiveSessionTransport, callSessionRpcForTransport, readSessionActionRpcOrigin, callSessionActionRpc, dispatchSessionLifecycleHookEvent, callResolvedSessionRpc };
}
