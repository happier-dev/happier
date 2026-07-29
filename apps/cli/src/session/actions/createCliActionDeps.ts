import { homedir } from 'node:os';

import {
  AcpConfigOptionOverridesV1Schema,
  BackendTargetRefV2Schema,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  buildBackendTargetKeyV2,
  getActionSpec,
  RuntimeDescriptorV1Schema,
  SessionAgentSpawnPolicyV1Schema,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
  SessionModelSelectionResolutionError,
  ProviderConnectionIdSchema,
  resolveExplicitSessionSpawnMachineTarget,
  resolveSessionModelSelectionInputRefV1,
  mergeSpawnConfigOptionAliases,
  readBackendTargetRefV2,
  readRuntimeDescriptorV1FromMetadata,
  resolveActionBackendTargetSelection,
  type ConnectedServiceBindingsV1,
  type SessionAgentSpawnPolicyV1,
  type SpawnConfigOptionValue,
  type SessionBridgeLifecycleHookEventIdV1,
  type SessionModelSelectionV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
  type ActionExecutorDeps,
  type ActionSurfaces,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';
import {
  assertNonEscalatingPermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  resolvePermissionPrivilegeOrdinal,
} from '@happier-dev/protocol/actions/permissionPrivilege';
import { SpawnSessionTerminalSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  resolveCanonicalAgentIdFromFlavor,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readSettings, type Credentials } from '@/persistence';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import {
  resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import { getSessionEvents } from '@/session/services/getSessionEvents';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import { listSessions } from '@/session/services/listSessions';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import { setSessionModel } from '@/session/services/setSessionModel';
import { setSessionMode } from '@/session/services/setSessionMode';
import { setSessionPermissionMode } from '@/session/services/setSessionPermissionMode';
import { setSessionTitle } from '@/session/services/setSessionTitle';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';

import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  executeExecutionRunAction,
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  waitForExecutionRun,
} from '@/session/services/executionRuns';
import { buildPluginInstallApprovalPreview } from '@/plugins/devLoop/installApprovalPreview';
import {
  normalizeExecutionRunWaitPollIntervalMs,
  normalizeExecutionRunWaitTimeoutMs,
} from '@/session/services/executionRunWaitTiming';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById, fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import {
  normalizeUsageLimitRecoveryOperationResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
  isConcreteBackendTargetCompatId,
} from '@/session/backendTargets/compat/customAcp';
import {
  resolveBackendTargetFromSessionMetadata,
  resolveExplicitBackendTargetFromSessionMetadata,
} from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveSessionAgentSpawnInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';
import {
  readSessionAgentState,
  readSessionMetadata,
} from './cliActionDeps/sessionStateReaders';
import {
  HostSubagentStoreError,
  hostSubagentStore,
} from '@/session/subagents/hostSubagentStore';
import {
  resolveUsageLimitRecoveryEnabled,
  usageLimitRecoveryDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

function serializeHostSubagentStoreError(error: unknown): Readonly<{ ok: false; errorCode: string; error: string }> {
  if (error instanceof HostSubagentStoreError) {
    return { ok: false, errorCode: error.code, error: error.code };
  }
  throw error;
}

function normalizeStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | undefined {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : undefined;
}

export type ResumeInactiveSessionWhenUsageLimitReady = (input: Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>) => Promise<boolean>;

export type ScheduleInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  recovery: SessionUsageLimitRecoveryV1;
  runCheckNow: () => Promise<unknown>;
}>) => Promise<void> | void;

export type CancelInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}>) => Promise<void> | void;

export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
}>) => Promise<unknown> | unknown;

export type RetryTemporaryThrottleNow = (input: Readonly<{
  sessionId: string;
}>) => Promise<unknown> | unknown;

type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readConfigOptionsRecord(value: unknown): Record<string, SpawnConfigOptionValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => (
    typeof entryValue === 'string'
    || typeof entryValue === 'number' && Number.isFinite(entryValue)
    || typeof entryValue === 'boolean'
    || entryValue === null
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
}

function hasExplicitString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExplicitValue(value: unknown): boolean {
  return value !== undefined;
}

function isSessionAgentSurface(surface: unknown): surface is 'agent' {
  return surface === 'agent';
}

function normalizeSessionAgentSpawnPolicy(raw: unknown): SessionAgentSpawnPolicyV1 {
  const parsed = SessionAgentSpawnPolicyV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
}

function resolveSpawnPolicyDeniedField(params: Readonly<{
  policy: SessionAgentSpawnPolicyV1;
  input: Readonly<{
    path?: unknown;
    directory?: unknown;
    host?: unknown;
    machineId?: unknown;
    serverId?: unknown;
    agentId?: unknown;
    backendTargetKey?: unknown;
    backendTarget?: unknown;
    modelId?: unknown;
    providerConnectionId?: unknown;
    permissionMode?: unknown;
    agentModeId?: unknown;
    sessionConfigOptionOverrides?: unknown;
    configOptions?: unknown;
    profileId?: unknown;
    environmentVariables?: unknown;
    connectedServices?: unknown;
    mcpSelection?: unknown;
    transcriptStorage?: unknown;
    runtimeDescriptorV1?: unknown;
  }>;
}>): string | null {
  const { policy, input } = params;
  if (!policy.allowCustomDirectory && hasExplicitString(input.path)) return 'path';
  if (!policy.allowCustomDirectory && hasExplicitString(input.directory)) return 'directory';
  if (!policy.allowCrossMachine && hasExplicitString(input.host)) return 'host';
  if (!policy.allowCrossMachine && hasExplicitString(input.machineId)) return 'machineId';
  if (!policy.allowCrossMachine && hasExplicitString(input.serverId)) return 'serverId';
  if (!policy.allowBackendTargetOverride && hasExplicitString(input.agentId)) return 'agentId';
  if (!policy.allowBackendTargetOverride && hasExplicitString(input.backendTargetKey)) return 'backendTargetKey';
  if (!policy.allowBackendTargetOverride && hasExplicitValue(input.backendTarget)) return 'backendTarget';
  if (!policy.allowBackendTargetOverride && hasExplicitValue(input.runtimeDescriptorV1)) return 'runtimeDescriptorV1';
  if (!policy.allowModelOverride && hasExplicitString(input.modelId)) return 'modelId';
  if (!policy.allowModelOverride && input.providerConnectionId !== undefined) return 'providerConnectionId';
  if (!policy.allowPermissionModeOverride && hasExplicitString(input.permissionMode)) return 'permissionMode';
  if (!policy.allowAgentModeOverride && hasExplicitString(input.agentModeId)) return 'agentModeId';
  if (!policy.allowConfigOptionOverrides && hasExplicitValue(input.sessionConfigOptionOverrides)) return 'sessionConfigOptionOverrides';
  if (!policy.allowConfigOptionOverrides && hasExplicitValue(input.configOptions)) return 'configOptions';
  if (!policy.allowProfileOverride && hasExplicitString(input.profileId)) return 'profileId';
  if (!policy.allowEnvironmentVariables && hasExplicitValue(input.environmentVariables)) return 'environmentVariables';
  if (!policy.allowConnectedServicesOverride && hasExplicitValue(input.connectedServices)) return 'connectedServices';
  if (!policy.allowMcpSelectionOverride && hasExplicitValue(input.mcpSelection)) return 'mcpSelection';
  if (!policy.allowTranscriptStorageOverride && hasExplicitValue(input.transcriptStorage)) return 'transcriptStorage';
  return null;
}

function permissionEscalationDetails(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Readonly<{
    reason: string;
    requestedMode: string;
    requestedOrdinal: number | null;
    callerMode: string;
    callerOrdinal: number;
  }>;
}>): Record<string, unknown> {
  return {
    surface: params.callerSurface ?? null,
    reason: params.decision.reason,
    requestedMode: params.decision.requestedMode,
    requestedOrdinal: params.decision.requestedOrdinal,
    callerMode: params.decision.callerMode,
    callerOrdinal: params.decision.callerOrdinal,
  };
}

function permissionEscalationActionResult(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Exclude<ReturnType<typeof assertNonEscalatingPermissionMode>, { ok: true }>;
}>): Readonly<{ ok: false; errorCode: string; error: string; details: Record<string, unknown> }> {
  return {
    ok: false,
    errorCode: params.decision.reason,
    error: params.decision.reason,
    details: permissionEscalationDetails(params),
  };
}

function permissionEscalationSpawnResult(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Exclude<ReturnType<typeof assertNonEscalatingPermissionMode>, { ok: true }>;
}>): Readonly<{
  type: 'error';
  errorCode: string;
  errorMessage: string;
  details: Record<string, unknown>;
}> {
  return {
    type: 'error',
    errorCode: params.decision.reason,
    errorMessage: params.decision.reason,
    details: permissionEscalationDetails(params),
  };
}

function applyPermissionCeiling(params: Readonly<{
  callerMode: string;
  permissionCeiling: SessionAgentSpawnPolicyV1['permissionCeiling'];
}>): string {
  if (!params.permissionCeiling) return params.callerMode;
  const callerOrdinal = resolvePermissionPrivilegeOrdinal(params.callerMode) ?? 1;
  const ceilingOrdinal = resolvePermissionPrivilegeOrdinal(params.permissionCeiling);
  if (ceilingOrdinal === null || ceilingOrdinal >= callerOrdinal) return params.callerMode;
  return params.permissionCeiling;
}

async function resolveSpawnConnectedServicesDefaultPayload(params: Readonly<{
  backendTarget: NonNullable<ReturnType<typeof readBackendTargetRefV2>>;
  credentials: Credentials;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null> {
  if (params.backendTarget.sourceKind !== 'built_in') return null;
  // ONE defaulting owner (QA2-F02): session spawn and execution-run start resolve defaults
  // through the same fresh-bootstrap owner; no local settings-snapshot path.
  return await resolveSessionSpawnConnectedServicesDefaultsPayload({
    agentId: params.backendTarget.backendId,
    credentials: params.credentials,
  });
}

type PendingAgentRequestKind = 'permission' | 'user_action';

function permissionRequestNotFoundResult(sessionId: string) {
  return {
    ok: false,
    errorCode: 'permission_request_not_found',
    errorMessage: 'permission_request_not_found',
    sessionId,
  } as const;
}

function isKnownCompletedRequestId(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  requestId: string;
  kind: PendingAgentRequestKind;
}>): boolean {
  const agentState = readSessionAgentState(params);
  const completedRequests = agentState?.completedRequests;
  if (!completedRequests || typeof completedRequests !== 'object' || Array.isArray(completedRequests)) {
    return false;
  }

  const completed = (completedRequests as Record<string, unknown>)[params.requestId];
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) {
    return false;
  }

  const requestKind = (completed as Record<string, unknown>).kind;
  if (params.kind === 'user_action') return requestKind === 'user_action';
  return requestKind === 'permission' || typeof requestKind === 'undefined';
}

export function createCliActionDeps(params: Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{
    metadata?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  getCallerPermissionMode?: (() => string | null | undefined) | null;
  getCurrentSessionBackendTarget?: (() => BackendTargetRefV2 | null | undefined) | null;
  happyHomeDir?: string;
  isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
}>): ActionExecutorDeps {
  const inventoryDeps = createCliActionInventoryDeps(params);
  const approvalsStore = params.credentials ? createCliApprovalsArtifactStore({ credentials: params.credentials }) : null;
  let currentSessionMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
  type ResolvedSessionTransport = Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    ctx: SessionEncryptionContext;
    mode: SessionStoredContentEncryptionMode;
  }>;
  type LifecycleHookSessionContext = Readonly<{
    machineId?: string;
    cwd?: string;
    workspaceId?: string;
  }>;

  const sessionTransportCache = new Map<string, ResolvedSessionTransport>();
  const ambiguousSpawnActionRequestIds = new Set<string>();

  const readCurrentSessionMetadata = async (): Promise<Record<string, unknown> | null> => {
    if (currentSessionMetadata) return currentSessionMetadata;

    try {
      const rawSession = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
      currentSessionMetadata = readSessionMetadata({
        rawSession,
        mode: params.mode,
        ctx: params.ctx,
      });
      return currentSessionMetadata;
    } catch {
      currentSessionMetadata = null;
      return null;
    }
  };

  const readValidPermissionMode = (value: unknown): string | null => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized && parsePermissionIntentAlias(normalized) ? normalized : null;
  };

  const resolveCallerPermissionMode = async (explicit: unknown): Promise<string> => {
    const explicitMode = readValidPermissionMode(explicit);
    if (explicitMode) return explicitMode;
    const liveMode = readValidPermissionMode(params.getCallerPermissionMode?.());
    if (liveMode) return liveMode;
    const metadata = await readCurrentSessionMetadata();
    return resolvePermissionIntentFromSessionMetadata(metadata)?.intent ?? 'default';
  };

  const resolveCurrentSessionValue = async (key: 'path' | 'host' | 'machineId'): Promise<string | null> => {
    const rawValue = params.rawSession?.[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }

    const metadata = await readCurrentSessionMetadata();
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };

  let currentMachineControlIdentityPromise: Promise<CurrentMachineControlIdentity> | null = null;

  const readCurrentMachineControlIdentity = async (): Promise<CurrentMachineControlIdentity> => {
    currentMachineControlIdentityPromise ??= (async () => {
      let machineId: string | null = null;
      try {
        machineId = normalizeStringValue((await readSettings()).machineId);
      } catch {
        machineId = null;
      }

      let host: string | null = null;
      try {
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

  const resolveTransportForSession = async (idOrPrefix: string): Promise<Readonly<{
    ok: true;
    sessionId: string;
    rawSession: any;
    ctx: SessionEncryptionContext;
    mode: SessionStoredContentEncryptionMode;
  }> | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>> => {
    if (!params.credentials) {
      return { ok: false, code: 'not_authenticated' };
    }

    const normalized = String(idOrPrefix ?? '').trim();
    if (!normalized) {
      return { ok: false, code: 'session_not_found' };
    }
    const cachedTransport = sessionTransportCache.get(normalized);
    if (cachedTransport) return { ok: true, ...cachedTransport };

    const resolved = await resolveSessionTransportContext({ credentials: params.credentials, idOrPrefix: normalized });
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }

    const cached = {
      sessionId: resolved.sessionId,
      rawSession: resolved.rawSession,
      ctx: resolved.ctx,
      mode: resolved.mode,
    } as const;
    sessionTransportCache.set(resolved.sessionId, cached);
    // If the input is already a full id, also cache by that literal.
    sessionTransportCache.set(normalized, cached);
    return { ok: true, ...cached };
  };

  const callSessionRpcForTransport = async (
    transport: ResolvedSessionTransport,
    methodSuffix: string,
    request: unknown,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    try {
      return await callSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        method: `${transport.sessionId}:${methodSuffix}`,
        request,
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
      const metadata = readSessionMetadata({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
      });
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
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
    }
    return await callSessionRpcForTransport(transport, method, request);
  };

  const isUsageLimitRecoveryEnabled = async (): Promise<boolean> => {
    if (typeof params.isUsageLimitRecoveryEnabled === 'function') {
      return await params.isUsageLimitRecoveryEnabled();
    }
    return await resolveUsageLimitRecoveryEnabled();
  };

  const callRoutedSessionGoalControl = async (
    sessionId: string,
    operation: 'get' | 'set' | 'clear',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readSessionMetadata({
      rawSession: transport.rawSession,
      mode: transport.mode,
      ctx: transport.ctx,
    });
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    return await routeSessionGoalControl({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      ctx: transport.ctx,
      mode: transport.mode,
      operation,
      ...(operation === 'set' ? { request } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        operation === 'get'
          ? SESSION_RPC_METHODS.SESSION_GOAL_GET
          : operation === 'clear'
            ? SESSION_RPC_METHODS.SESSION_GOAL_CLEAR
            : SESSION_RPC_METHODS.SESSION_GOAL_SET,
        request,
      ),
    });
  };

  const callRoutedSessionCatalogControl = async (
    sessionId: string,
    operation: 'vendorPlugins' | 'skills',
    request: Readonly<{ cwd?: string }>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: 'not_authenticated' }
        : { unsupported: true, skills: [], diagnostic: 'not_authenticated' };
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: transport.code }
        : { unsupported: true, skills: [], diagnostic: transport.code };
    }

    const metadata = readSessionMetadata({
      rawSession: transport.rawSession,
      mode: transport.mode,
      ctx: transport.ctx,
    });
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    const method = operation === 'vendorPlugins'
      ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST
      : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
    const rpcRequest = {
      ...(typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? { cwd: request.cwd.trim() } : {}),
    };
    return await routeSessionCatalogControl({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      ctx: transport.ctx,
      mode: transport.mode,
      operation,
      ...('cwd' in rpcRequest ? { cwd: rpcRequest.cwd } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        method,
        rpcRequest,
      ),
    });
  };

  const callRoutedUsageLimitRecoveryControl = async (
    sessionId: string,
    operation: 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow' | 'consumeResetCredit',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readSessionMetadata({
      rawSession: transport.rawSession,
      mode: transport.mode,
      ctx: transport.ctx,
    });
    if (transport.rawSession.active === true) {
      return normalizeUsageLimitRecoveryOperationResult(await callSessionRpcForTransport(
        transport,
        operation === 'enable'
          ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
          : operation === 'cancel'
            ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
            : operation === 'consumeResetCredit'
              ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
              : SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        request,
      ), { sessionId: transport.sessionId });
    }

    const rawMachineId = normalizeStringValue(transport.rawSession.machineId);
    const metadataMachineId = normalizeStringValue(metadata?.machineId);
    if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_mismatch',
        error: 'session_usage_limit_recovery_control_target_machine_mismatch',
      }, { sessionId: transport.sessionId });
    }
    const machineId = rawMachineId ?? metadataMachineId;
    if (!machineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }

    const method = operation === 'enable'
      ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
      : operation === 'cancel'
        ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
        : operation === 'consumeResetCredit'
          ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
          : RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW;
    try {
      return normalizeUsageLimitRecoveryOperationResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method,
        request,
      }), { sessionId: transport.sessionId });
    } catch {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }
  };

  return {
    executionRunStart: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await startExecutionRun({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
      });
    },
    executionRunList: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await listExecutionRuns({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
        skipLiveRpc: transport.rawSession.active === false,
      });
    },
    executionRunGet: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await getExecutionRun({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
      });
    },
    executionRunSend: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await sendExecutionRunMessage({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
      });
    },
    executionRunStop: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await stopExecutionRun({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
      });
    },
    executionRunAction: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await executeExecutionRunAction({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        request,
      });
    },
    executionRunWait: async (sessionId, request) => {
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }

      const pollIntervalMs = normalizeExecutionRunWaitPollIntervalMs(
        (request as any)?.pollIntervalMs,
        normalizeExecutionRunWaitPollIntervalMs(process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS),
      );

      return await waitForExecutionRun({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        runId: String((request as any)?.runId ?? ''),
        timeoutMs: normalizeExecutionRunWaitTimeoutMs((request as any)?.timeoutSeconds),
        pollIntervalMs,
      });
    },
    reviewStartInline: async ({ sessionId, input }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, input);
    },

    daemonMemorySearch: async () => notSupported(),
    daemonMemoryGetWindow: async () => notSupported(),
    daemonMemoryEnsureUpToDate: async () => notSupported(),

    sessionOpen: async () => notSupported(),
    sessionFork: async () => notSupported(),
    sessionRollback: async () => notSupported(),
    sessionSpawnNew: async ({
      tag,
      agentId,
      modelId,
      providerConnectionId,
      modelUpdatedAt,
      backendTargetKey,
      backendTarget: requestedBackendTarget,
      title,
      path,
      directory: directoryAlias,
      host,
      machineId,
      serverId,
      initialMessage,
      initialPrompt,
      permissionMode,
      permissionModeUpdatedAt,
      agentModeId,
      agentModeUpdatedAt,
      sessionConfigOptionOverrides,
      configOptions,
      profileId,
      environmentVariables,
      connectedServices,
      connectedServicesUpdatedAt,
      mcpSelection,
      transcriptStorage,
      terminal,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      windowsTerminalWindowName,
      runtimeDescriptorV1,
      callerSurface,
      callerPermissionMode,
      sessionAgentSpawnPolicyV1,
      actionRequestId,
      resumeActionRequest,
    }) => {
      if (!params.credentials) {
        notSupported();
      }

      const sessionAgentCaller = isSessionAgentSurface(callerSurface);
      const spawnPolicy = sessionAgentCaller
        ? normalizeSessionAgentSpawnPolicy(sessionAgentSpawnPolicyV1)
        : null;
      if (spawnPolicy) {
        const deniedField = resolveSpawnPolicyDeniedField({
          policy: spawnPolicy,
          input: {
            path,
            directory: directoryAlias,
            host,
            machineId,
            serverId,
            agentId,
            backendTargetKey,
            backendTarget: requestedBackendTarget,
            modelId,
            providerConnectionId,
            permissionMode,
            agentModeId,
            sessionConfigOptionOverrides,
            configOptions,
            profileId,
            environmentVariables,
            connectedServices,
            mcpSelection,
            transcriptStorage,
            runtimeDescriptorV1,
          },
        });
        if (deniedField) {
          return {
            type: 'error',
            errorCode: 'spawn_policy_denied',
            errorMessage: 'spawn_policy_denied',
            field: deniedField,
            surface: 'agent',
          };
        }
      }

      const requestedHost = typeof host === 'string' ? host.trim() : '';
      const explicitMachineId = typeof machineId === 'string' ? machineId.trim() : '';
      const currentMachineId = await resolveCurrentSessionValue('machineId');
      let resolvedMachineId = currentMachineId;

      if (explicitMachineId) {
        const requestedServerId = typeof serverId === 'string' ? serverId.trim() : '';
        const activeServerId = String(configuration.activeServerId ?? '').trim();
        if (requestedServerId && requestedServerId !== activeServerId) {
          return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
        }

        const currentMachineIdentity = await readCurrentMachineControlIdentity();
        const explicitTarget = resolveExplicitSessionSpawnMachineTarget({
          machineId: explicitMachineId,
          host: requestedHost,
          machines: currentMachineIdentity.machineId
            ? [{ machineId: currentMachineIdentity.machineId, host: currentMachineIdentity.host }]
            : [],
        });
        if (explicitTarget.kind !== 'resolved') {
          return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
        }
        resolvedMachineId = explicitTarget.machineId;
      } else if (requestedHost) {
        const currentHost = await resolveCurrentSessionValue('host');
        if (!currentHost || requestedHost !== currentHost || !currentMachineId) {
          return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
        }
      }

      const explicitDirectory = typeof path === 'string' && path.trim().length > 0
        ? path.trim()
        : typeof directoryAlias === 'string' && directoryAlias.trim().length > 0
          ? directoryAlias.trim()
          : '';
      const directory = explicitDirectory
        ? explicitDirectory
        : explicitMachineId && explicitMachineId !== currentMachineId
          ? null
          : await resolveCurrentSessionValue('path');
      if (!directory) {
        return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
      }

      const rawBackendTargetKey = typeof backendTargetKey === 'string' ? backendTargetKey.trim() : '';
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const canonicalAgentId = normalizedAgentId ? resolveCanonicalAgentIdFromFlavor(normalizedAgentId) : null;
      const normalizedTag = typeof tag === 'string' ? tag.trim() : '';
      const normalizedTitle = typeof title === 'string' ? title.trim() : '';
      const normalizedInitialMessage = typeof initialMessage === 'string' && initialMessage.trim().length > 0
        ? initialMessage.trim()
        : typeof initialPrompt === 'string' && initialPrompt.trim().length > 0
          ? initialPrompt.trim()
          : '';
      const currentMetadata = await readCurrentSessionMetadata();
      const explicitRuntimeDescriptorV1 = (() => {
        if (runtimeDescriptorV1 === undefined) return undefined;
        const parsed = RuntimeDescriptorV1Schema.safeParse(runtimeDescriptorV1);
        return parsed.success ? parsed.data : undefined;
      })();
      if (runtimeDescriptorV1 !== undefined && explicitRuntimeDescriptorV1 === undefined) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      const hasExplicitBackendTargetInput = requestedBackendTarget != null
        || rawBackendTargetKey.length > 0
        || normalizedAgentId.length > 0;
      const inheritedRuntimeDescriptorV1 = (() => {
        if (runtimeDescriptorV1 !== undefined || hasExplicitBackendTargetInput) return undefined;
        const inherited = readRuntimeDescriptorV1FromMetadata(currentMetadata) ?? undefined;
        if (!inherited) return undefined;
        return resolveActionBackendTargetSelection({ runtimeDescriptorV1: inherited }).ok
          ? inherited
          : undefined;
      })();
      const normalizedRuntimeDescriptorV1 = explicitRuntimeDescriptorV1 ?? inheritedRuntimeDescriptorV1;
      const explicitBackendTarget = (() => {
        if (requestedBackendTarget == null) return { ok: true as const, value: null };
        const parsed = BackendTargetRefV2Schema.safeParse(requestedBackendTarget);
        return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const };
      })();
      if (!explicitBackendTarget.ok) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }

      const resolvedExplicitTargetSelection = resolveActionBackendTargetSelection({
        ...(canonicalAgentId || normalizedAgentId
          ? { agentId: canonicalAgentId ?? normalizedAgentId }
          : {}),
        ...(rawBackendTargetKey ? { backendTargetKey: rawBackendTargetKey } : {}),
        ...(explicitBackendTarget.value ? { backendTarget: explicitBackendTarget.value } : {}),
        ...(explicitRuntimeDescriptorV1 ? { runtimeDescriptorV1: explicitRuntimeDescriptorV1 } : {}),
      });
      if (!resolvedExplicitTargetSelection.ok) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }

      const backendTarget = (() => {
        if (resolvedExplicitTargetSelection.selection.canonicalBackendTarget) {
          return resolvedExplicitTargetSelection.selection.canonicalBackendTarget;
        }
        if (normalizedAgentId) {
          if (!canonicalAgentId) return null;
          return readBackendTargetRefV2({
            kind: 'backend',
            backendId: canonicalAgentId,
            sourceKind: 'built_in',
          });
        }
        const explicitRuntimeDescriptorProviderId = explicitRuntimeDescriptorV1?.agentId;
        if (explicitRuntimeDescriptorProviderId && isConcreteBackendTargetCompatId(explicitRuntimeDescriptorProviderId)) {
          try {
            return readBackendTargetRefV2({
              kind: 'backend',
              backendId: explicitRuntimeDescriptorProviderId,
              sourceKind: 'built_in',
            });
          } catch {
            return null;
          }
        }
        const currentSessionBackendTarget = params.getCurrentSessionBackendTarget?.() ?? null;
        if (currentSessionBackendTarget) {
          return currentSessionBackendTarget;
        }
        const metadataBackendTarget = resolveBackendTargetFromSessionMetadata(currentMetadata);
        if (metadataBackendTarget) {
          return metadataBackendTarget;
        }
        return readBackendTargetRefV2({
          kind: 'backend',
          backendId: DEFAULT_AGENT_ID,
          sourceKind: 'built_in',
        });
      })();
      if (!backendTarget) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      if (backendTarget.sourceKind === 'built_in' && normalizedAgentId && !AGENT_IDS.includes(normalizedAgentId as AgentId)) {
        return { type: 'error', errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
      }
      const hookBackendTarget = buildBackendTargetKeyV2(backendTarget);
      const inheritedMetadataBackendTarget = params.getCurrentSessionBackendTarget?.()
        ?? resolveExplicitBackendTargetFromSessionMetadata(currentMetadata);
      let inheritedSpawn: ReturnType<typeof resolveSessionAgentSpawnInheritedOverridesFromMetadata>['spawn'];
      try {
        inheritedSpawn = resolveSessionAgentSpawnInheritedOverridesFromMetadata(
          currentMetadata,
          inheritedMetadataBackendTarget,
        ).spawn;
      } catch (error) {
        if (error instanceof SessionModelSelectionResolutionError) {
          return { type: 'error', errorCode: 'invalid_parameters', errorMessage: error.code };
        }
        throw error;
      }

      const resolvedConnectedServices = connectedServices !== undefined
        ? connectedServices
        : inheritedSpawn.connectedServices;
      const connectedServicesDefaults = resolvedConnectedServices === undefined
        ? await resolveSpawnConnectedServicesDefaultPayload({
            credentials: params.credentials,
            backendTarget,
          })
        : null;
      const resolvedCallerPermissionMode = sessionAgentCaller
        ? applyPermissionCeiling({
            callerMode: await resolveCallerPermissionMode(callerPermissionMode),
            permissionCeiling: spawnPolicy?.permissionCeiling ?? null,
          })
        : 'yolo';
      const permissionDecision = sessionAgentCaller
        ? (typeof permissionMode === 'string' && permissionMode.trim().length > 0
            ? assertNonEscalatingPermissionMode({
                requestedMode: permissionMode,
                callerMode: resolvedCallerPermissionMode,
              })
            : resolveNearestPermissionModeAtOrBelow({
                requestedMode: undefined,
                callerMode: resolvedCallerPermissionMode,
                supportedModes: ['plan', 'read-only', 'default', 'safe-yolo', 'yolo'],
              }))
        : (typeof permissionMode === 'string' && permissionMode.trim().length > 0
            ? assertNonEscalatingPermissionMode({
                requestedMode: permissionMode,
                callerMode: 'yolo',
              })
            : inheritedSpawn.permissionMode
              ? assertNonEscalatingPermissionMode({
                  requestedMode: inheritedSpawn.permissionMode,
                  callerMode: 'yolo',
                })
              : null);
      if (permissionDecision?.ok === false) {
        return permissionEscalationSpawnResult({
          callerSurface,
          decision: permissionDecision,
        });
      }
      const normalizedPermissionMode = permissionDecision?.ok === true
        ? permissionDecision.normalizedMode
        : undefined;
      const normalizedPermissionModeUpdatedAt = typeof permissionModeUpdatedAt === 'number'
        ? permissionModeUpdatedAt
        : permissionMode === undefined && inheritedSpawn.permissionMode === normalizedPermissionMode
          ? inheritedSpawn.permissionModeUpdatedAt
          : undefined;
      const resolvedAgentTargetKey = buildBackendTargetKeyV2(backendTarget);
      const parsedProviderConnectionId = providerConnectionId === undefined || providerConnectionId === null
        ? { success: true as const, data: null }
        : ProviderConnectionIdSchema.safeParse(providerConnectionId);
      if (!parsedProviderConnectionId.success) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      const explicitModelId = typeof modelId === 'string' ? modelId.trim() : '';
      if (providerConnectionId !== undefined && !explicitModelId) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      const resolvedModelSelection: SessionModelSelectionV1 | undefined = (() => {
        if (modelId === undefined) {
          const inherited = inheritedSpawn.modelSelection;
          return inherited?.ref.agentTargetKey === resolvedAgentTargetKey ? inherited : undefined;
        }
        const ref = resolveSessionModelSelectionInputRefV1({
          agentTargetKey: resolvedAgentTargetKey,
          providerConnectionId: parsedProviderConnectionId.data,
          modelId: explicitModelId,
        });
        if (ref === null) return undefined;
        return SessionModelSelectionV1Schema.parse({
          v: 1,
          updatedAt: typeof modelUpdatedAt === 'number' && Number.isFinite(modelUpdatedAt)
            ? modelUpdatedAt
            : Date.now(),
          ref,
        });
      })();
      const resolvedAgentModeId = typeof agentModeId === 'string'
        ? agentModeId
        : agentModeId === undefined
          ? inheritedSpawn.agentModeId
          : undefined;
      const resolvedAgentModeUpdatedAt = typeof agentModeUpdatedAt === 'number'
        ? agentModeUpdatedAt
        : agentModeId === undefined
          ? inheritedSpawn.agentModeUpdatedAt
          : undefined;
      const resolvedProfileId = typeof profileId === 'string'
        ? profileId
        : profileId === undefined
          ? inheritedSpawn.profileId
          : undefined;
      const normalizedEnvironmentVariables = readStringRecord(environmentVariables);
      const normalizedSessionConfigOptionOverrides = (() => {
        const value = sessionConfigOptionOverrides === undefined
          ? inheritedSpawn.sessionConfigOptionOverrides
          : sessionConfigOptionOverrides;
        const parsed = value === undefined ? null : AcpConfigOptionOverridesV1Schema.safeParse(value);
        const parsedConfigOptions = readConfigOptionsRecord(configOptions);
        return mergeSpawnConfigOptionAliases({
          sessionConfigOptionOverrides: parsed?.success ? parsed.data : undefined,
          configOptions: parsedConfigOptions,
        });
      })();
      const normalizedMcpSelection = (() => {
        const value = mcpSelection === undefined ? inheritedSpawn.mcpSelection : mcpSelection;
        if (value === undefined) return undefined;
        const parsed = SessionMcpSelectionV1Schema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      })();
      const normalizedTerminal = (() => {
        if (terminal === undefined) return undefined;
        const parsed = SpawnSessionTerminalSchema.safeParse(terminal);
        return parsed.success ? parsed.data : undefined;
      })();

      const normalizedActionRequestId = typeof actionRequestId === 'string' && actionRequestId.trim().length > 0
        ? actionRequestId.trim()
        : null;
      const spawnNonce = normalizedActionRequestId
        ? `session.spawn_new:${params.sessionId}:${normalizedActionRequestId}`
        : null;
      const resumeOnly = Boolean(
        spawnNonce
        && (resumeActionRequest === true || ambiguousSpawnActionRequestIds.has(spawnNonce)),
      );
      if (spawnNonce && !resumeOnly) ambiguousSpawnActionRequestIds.add(spawnNonce);

      let created: Awaited<ReturnType<typeof createSpawnedSession>>;
      try {
        created = await createSpawnedSession({
          credentials: params.credentials,
          directory,
          ...(resolvedMachineId ? { machineId: resolvedMachineId } : {}),
          backendTarget,
          ...(connectedServicesDefaults ?? {}),
          ...(resolvedConnectedServices !== undefined ? { connectedServices: resolvedConnectedServices } : {}),
          ...(typeof connectedServicesUpdatedAt === 'number'
            ? { connectedServicesUpdatedAt }
            : connectedServices === undefined && typeof inheritedSpawn.connectedServicesUpdatedAt === 'number'
              ? { connectedServicesUpdatedAt: inheritedSpawn.connectedServicesUpdatedAt }
              : {}),
          ...(normalizedTag ? { tag: normalizedTag } : {}),
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
          ...(normalizedInitialMessage ? { initialMessage: normalizedInitialMessage } : {}),
          ...(resolvedModelSelection ? { modelSelection: resolvedModelSelection } : {}),
          ...(normalizedPermissionMode ? { permissionMode: normalizedPermissionMode } : {}),
          ...(typeof normalizedPermissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt } : {}),
          ...(typeof resolvedAgentModeId === 'string' ? { agentModeId: resolvedAgentModeId } : {}),
          ...(typeof resolvedAgentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: resolvedAgentModeUpdatedAt } : {}),
          ...(normalizedSessionConfigOptionOverrides ? { sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides } : {}),
          ...(typeof resolvedProfileId === 'string' ? { profileId: resolvedProfileId } : {}),
          ...(normalizedEnvironmentVariables ? { environmentVariables: normalizedEnvironmentVariables } : {}),
          ...(normalizedMcpSelection ? { mcpSelection: normalizedMcpSelection } : {}),
          ...(transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? { transcriptStorage } : {}),
          ...(normalizedTerminal ? { terminal: normalizedTerminal } : {}),
          ...(windowsRemoteSessionLaunchMode !== undefined ? { windowsRemoteSessionLaunchMode } : {}),
          ...(windowsRemoteSessionConsole !== undefined ? { windowsRemoteSessionConsole } : {}),
          ...(typeof windowsTerminalWindowName === 'string' ? { windowsTerminalWindowName } : {}),
          ...(normalizedRuntimeDescriptorV1 ? { runtimeDescriptorV1: normalizedRuntimeDescriptorV1 } : {}),
          ...(spawnNonce ? { spawnNonce } : {}),
          ...(resumeOnly ? { resumeOnly: true } : {}),
        });
      } catch (error) {
        const details = error && typeof error === 'object'
          ? (error as { details?: unknown }).details
          : null;
        const ambiguousNonce = details && typeof details === 'object'
          && typeof (details as { spawnNonce?: unknown }).spawnNonce === 'string'
          ? (details as { spawnNonce: string }).spawnNonce
          : null;
        if (spawnNonce && ambiguousNonce !== spawnNonce) ambiguousSpawnActionRequestIds.delete(spawnNonce);
        throw error;
      }
      if (spawnNonce) ambiguousSpawnActionRequestIds.delete(spawnNonce);

      const isConfiguredBackendTarget = backendTarget.sourceKind === 'configured'
        || Boolean(backendTarget.configuredBackendId);
      const backendTargetAgentId = isConfiguredBackendTarget
        ? null
        : resolveCanonicalAgentIdFromFlavor(backendTarget.backendId);
      const lifecycleAgentId = normalizedRuntimeDescriptorV1?.agentId
        ?? canonicalAgentId
        ?? backendTargetAgentId;
      if (lifecycleAgentId) {
        try {
          await dispatchSessionLifecycleHookEvent({
            eventId: 'session.spawned',
            happySessionId: created.sessionId,
            backendTarget: hookBackendTarget,
            exactSessionContext: {
              ...(resolvedMachineId ? { machineId: resolvedMachineId } : {}),
              cwd: directory,
            },
            payload: {
              sessionId: created.sessionId,
              agentId: lifecycleAgentId,
              runtimeTarget: backendTarget,
              cwd: directory,
              ...(requestedHost ? { host: requestedHost } : {}),
              ...(normalizedTag ? { tag: normalizedTag } : {}),
              ...(resolvedModelSelection ? { modelId: resolvedModelSelection.ref.modelId } : {}),
              ...(normalizedInitialMessage ? { initialMessage: normalizedInitialMessage } : {}),
              ...(resolvedMachineId ? { machineId: resolvedMachineId } : {}),
            },
          });
        } catch {
          // Hook dispatch is best-effort so a misbehaving plugin cannot break session creation.
        }
      }

      return {
        type: 'success',
        sessionId: created.sessionId,
        created: created.created,
        session: created.session,
      };
    },
    sessionSpawnPicker: async () => notSupported(),
    ...(approvalsStore ?? {}),
    ...inventoryDeps,
    sessionSendMessage: async ({
      sessionId,
      message,
      wait,
      timeoutSeconds,
      permissionModeOverride,
      modelOverride,
      providerConnectionId,
      callerSurface,
      callerPermissionMode,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedWait = typeof wait === 'boolean' ? wait : false;
      const normalizedTimeoutSeconds =
        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? Math.min(3600, timeoutSeconds)
          : 300;
      const permissionOverrideDecision = isSessionAgentSurface(callerSurface) && typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
        ? assertNonEscalatingPermissionMode({
            requestedMode: permissionModeOverride,
            callerMode: await resolveCallerPermissionMode(callerPermissionMode),
          })
        : null;
      if (permissionOverrideDecision?.ok === false) {
        return permissionEscalationActionResult({
          callerSurface,
          decision: permissionOverrideDecision,
        });
      }
      const normalizedPermissionModeOverride = permissionOverrideDecision?.ok === true
        ? permissionOverrideDecision.normalizedMode
        : typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
          ? permissionModeOverride.trim()
          : undefined;
      const normalizedProviderConnectionId = providerConnectionId === null
        ? null
        : providerConnectionId === undefined
          ? undefined
          : ProviderConnectionIdSchema.parse(providerConnectionId);
      const normalizedModelOverride = modelOverride === null
        ? null
        : typeof modelOverride === 'string' && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : undefined;
      if (normalizedProviderConnectionId !== undefined
        && normalizedProviderConnectionId !== null
        && (normalizedModelOverride === undefined || normalizedModelOverride === null)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const modelSelectionInput = normalizedModelOverride === undefined
        ? undefined
        : {
            ...(normalizedProviderConnectionId !== undefined
              ? { providerConnectionId: normalizedProviderConnectionId }
              : {}),
            modelId: normalizedModelOverride,
          };

      const res = await sendSessionMessage({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        message: String(message ?? ''),
        wait: normalizedWait,
        timeoutMs: normalizedTimeoutSeconds * 1000,
        ...(normalizedPermissionModeOverride ? { permissionModeOverride: normalizedPermissionModeOverride } : {}),
        ...(modelSelectionInput ? { modelSelectionInput } : {}),
      });
      if (!res.ok) {
        return {
          ok: false,
          errorCode: res.code,
          error: res.code,
          ...(res.candidates ? { candidates: res.candidates } : {}),
          ...(res.message ? { message: res.message } : {}),
          ...(res.providerError ? { details: res.providerError } : {}),
        };
      }
      const canonicalSessionId = typeof res.sessionId === 'string' && res.sessionId.trim().length > 0
        ? res.sessionId
        : sessionId;
      try {
        await dispatchSessionLifecycleHookEvent({
          eventId: 'session.message.send',
          happySessionId: canonicalSessionId,
          payload: {
            sessionId: canonicalSessionId,
            text: String(message ?? ''),
            source: callerSurface === 'agent' ? 'plugin' : 'user',
          },
        });
      } catch {
        // Hook dispatch is best-effort so a misbehaving plugin cannot break message send.
      }
      return res;
    },

    sessionStop: async ({ sessionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId });
    },

    sessionTitleSet: async ({ sessionId, title }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedTitle = String(title ?? '').trim();
      if (!normalizedTitle) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await setSessionTitle({ credentials: params.credentials, idOrPrefix: sessionId, title: normalizedTitle });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, title: normalizedTitle };
    },

    sessionPermissionModeSet: async ({ sessionId, permissionMode, callerSurface, callerPermissionMode }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const permissionDecision = isSessionAgentSurface(callerSurface)
        ? assertNonEscalatingPermissionMode({
            requestedMode: permissionMode,
            callerMode: await resolveCallerPermissionMode(callerPermissionMode),
          })
        : null;
      if (permissionDecision?.ok === false) {
        return permissionEscalationActionResult({
          callerSurface,
          decision: permissionDecision,
        });
      }
      const parsed = parsePermissionIntentAlias(
        permissionDecision?.ok === true
          ? permissionDecision.normalizedMode
          : String(permissionMode ?? '').trim(),
      );
      if (!parsed) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      const res = await setSessionPermissionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        permissionMode: parsed as PermissionIntent,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, permissionMode: parsed, updatedAt };
    },

    sessionModelSet: async ({ sessionId, modelId, providerConnectionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedModelId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await setSessionModel({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modelId: normalizedModelId,
        ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
      });
      if (!res.ok) {
        const errorCode = 'code' in res ? res.code : res.status;
        return {
          ok: false,
          errorCode,
          error: errorCode,
          ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}),
          ...('status' in res
            ? {
                details: {
                  status: res.status,
                  activeSelection: res.activeSelection,
                  requestedSelection: res.requestedSelection,
                  ...('reason' in res && res.reason ? { reason: res.reason } : {}),
                },
              }
            : {}),
        };
      }
      if (res.status === 'intent_updated') {
        return {
          ok: true,
          status: res.status,
          sessionId: res.sessionId,
          modelId: res.selection.modelId,
          selection: res.selection,
          updatedAt: res.updatedAt,
        };
      }
      return {
        ...res,
        modelId: res.activeSelection.modelId,
      };
    },

    sessionArchiveSet: async ({ sessionId, archived }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await setSessionArchivedState({ credentials: params.credentials, idOrPrefix: sessionId, archived: archived === true });
    },

    sessionStatusGet: async ({ sessionId, live }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await getSessionStatus({ credentials: params.credentials, idOrPrefix: sessionId, live: live === true });
    },

    sessionWorkStateGet: async ({ sessionId }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, {});
    },

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, {
        sessionId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, {
        sessionId,
        localId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionGoalGet: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'get', {});
    },

    sessionGoalSet: async ({ sessionId, objective, status, tokenBudget }) => {
      return await callRoutedSessionGoalControl(sessionId, 'set', {
        ...(typeof objective === 'string' ? { objective } : {}),
        ...(typeof status === 'string' && status.trim().length > 0 ? { status: status.trim() } : {}),
        ...(typeof tokenBudget !== 'undefined' ? { tokenBudget: tokenBudget ?? null } : {}),
      });
    },

    sessionGoalClear: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'clear', {});
    },

    sessionUsageLimitWaitResumeEnable: async ({ sessionId, issueFingerprint, remember, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      const request = {
        sessionId,
        ...(typeof issueFingerprint === 'string' ? { issueFingerprint } : {}),
        ...(remember === true ? { rememberPreference: true } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'enable', request);
    },

    sessionUsageLimitWaitResumeCancel: async ({ sessionId, issueFingerprint, armedAtMs, runtimeAuthRecoveryAttemptId }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const request = {
        sessionId,
        ...(issueFingerprint !== undefined ? { issueFingerprint } : {}),
        ...(typeof armedAtMs === 'number' && Number.isFinite(armedAtMs)
          ? { armedAtMs: Math.trunc(armedAtMs) }
          : {}),
        ...(typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0
          ? { runtimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId.trim() }
          : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'cancel', request);
    },

    sessionUsageLimitCheckNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'checkNow', {
        sessionId,
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitSwitchAccountNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'switchAccountNow', {
        sessionId,
        operation: 'switch_account_now',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitConsumeResetCredit: async ({ sessionId, agentId, issueFingerprint, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedIssueFingerprint = typeof issueFingerprint === 'string' ? issueFingerprint.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'consumeResetCredit', {
        sessionId,
        operation: 'consume_reset_credit',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedIssueFingerprint.length > 0 ? { issueFingerprint: normalizedIssueFingerprint } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionVendorPluginCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'vendorPlugins', { cwd });
    },

    sessionSkillCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'skills', { cwd });
    },

    sessionHistoryGet: async ({ sessionId, limit, format, includeMeta, includeStructuredPayload }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedLimit =
	        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
	          ? Math.min(1000, Math.floor(limit))
	          : 50;
	      const normalizedFormat = format === 'raw' || format === 'compact' ? format : 'compact';
	      return await getSessionEvents({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        limit: normalizedLimit,
	        format: normalizedFormat,
	        includeMeta: includeMeta === true,
	        includeStructuredPayload: includeStructuredPayload === true,
	      });
	    },

    sessionTranscriptGet: async ({
      sessionId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      includeTools,
      includeReasoning,
      includeEvents,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxCharsPerMessage,
      maxRawPayloadChars,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(typeof includeTools === 'boolean' ? { includeTools } : {}),
        ...(typeof includeReasoning === 'boolean' ? { includeReasoning } : {}),
        ...(typeof includeEvents === 'boolean' ? { includeEvents } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
        ...(maxRawPayloadChars !== undefined ? { maxRawPayloadChars } : {}),
      });
    },

    sessionEventsGet: async ({
      sessionId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      kinds,
      format,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxTextChars,
      maxPayloadChars,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionEvents({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(kinds ? { kinds } : {}),
        ...(format ? { format } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        ...(typeof maxPayloadChars === 'number' ? { maxPayloadChars } : {}),
      });
    },

	    sessionWaitIdle: async ({ sessionId, timeoutSeconds }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedTimeoutSeconds =
	        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
	          ? Math.min(3600, timeoutSeconds)
	          : 300;
	      return await waitForSessionIdle({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        timeoutMs: Math.max(1, Math.floor(normalizedTimeoutSeconds * 1000)),
	      });
	    },

    sessionPermissionRespond: async ({
      sessionId,
      decision,
      requestId,
      allowedTools,
      updatedPermissions,
      execPolicyAmendment,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      if (isKnownCompletedRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: reqId,
        kind: 'permission',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const approved = decision === 'allow';
      const legacyDecision =
        !approved
          ? 'denied'
          : execPolicyAmendment && typeof execPolicyAmendment === 'object'
            ? 'approved_execpolicy_amendment'
            : undefined;
      try {
        return await callSessionRpc({
          token: params.credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
          mode: transport.mode,
          method: `${transport.sessionId}:session.permission.respond`,
          request: {
            id: reqId,
            approved,
            ...(legacyDecision ? { decision: legacyDecision } : {}),
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          },
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionUserActionAnswer: async ({
      sessionId,
      requestId,
      answers,
      decision,
      reason,
      updatedPermissions,
      allowedTools,
      execPolicyAmendment,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      if (isKnownCompletedRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: reqId,
        kind: 'user_action',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim().length > 0 && entry.values.length > 0) {
          normalizedAnswers[question] = [...entry.values];
        }
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const approved = decision ? decision === 'approve' : true;
      const legacyDecision =
        decision === 'reject'
          ? 'denied'
          : decision === 'request_changes'
            ? 'abort'
            : 'approved';
      try {
        return await callSessionRpc({
          token: params.credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
          mode: transport.mode,
          method: `${transport.sessionId}:session.user_action.answer`,
          request: {
            id: reqId,
            approved,
            decision: legacyDecision,
            ...(decision ? { actionDecision: decision } : {}),
            ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
            ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          },
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionModeSet: async ({ sessionId, modeId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedModeId = String(modeId ?? '').trim();
      const updatedAt = Date.now();
      const res = await setSessionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modeId: normalizedModeId,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, modeId: normalizedModeId, updatedAt };
    },
    sessionTargetPrimarySet: async ({ sessionId }) => {
      const normalized = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
      return { ok: true, sessionId: normalized };
    },
    sessionTargetTrackedSet: async ({ sessionIds }) => {
      const trackedSessionIds = Array.isArray(sessionIds)
        ? sessionIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
      return { ok: true, sessionIds: trackedSessionIds };
    },

    sessionList: async ({ limit, cursor, activeOnly, archivedOnly, includeSystem, resumableOnly, includeRows, includeLastMessagePreview }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedActiveOnly = activeOnly === true;
      const normalizedArchivedOnly = archivedOnly === true;
      if (normalizedActiveOnly && normalizedArchivedOnly) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await listSessions({
        credentials: params.credentials,
        activeOnly: normalizedActiveOnly,
        archivedOnly: normalizedArchivedOnly,
        includeSystem: includeSystem === true,
        resumableOnly: resumableOnly === true,
        includeRows: includeRows === true,
        includeLastMessagePreview: includeLastMessagePreview === true,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(typeof cursor === 'string' && cursor.trim().length > 0 ? { cursor: cursor.trim() } : {}),
      });
      return res;
    },

    sessionActivityGet: async ({ sessionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const session = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId }).catch(() => null);
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found', sessionId };
      }
      return {
        ok: true,
        sessionId,
        active: Boolean(session.active),
        updatedAt: typeof (session as any).updatedAt === 'number' ? (session as any).updatedAt : null,
        pendingCount: typeof (session as any).pendingCount === 'number' ? (session as any).pendingCount : 0,
        pendingPermissionRequestCount: typeof (session as any).pendingPermissionRequestCount === 'number'
          ? (session as any).pendingPermissionRequestCount
          : 0,
        pendingUserActionRequestCount: typeof (session as any).pendingUserActionRequestCount === 'number'
          ? (session as any).pendingUserActionRequestCount
          : 0,
      };
    },

    sessionRecentMessagesGet: async ({ sessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(Object.prototype.hasOwnProperty.call({ cursor }, 'cursor') ? { cursor: cursor ?? null } : {}),
        roles: [
          ...(includeUser === false ? [] : ['user' as const]),
          ...(includeAssistant === false ? [] : ['assistant' as const]),
        ],
        ...(Object.prototype.hasOwnProperty.call({ maxCharsPerMessage }, 'maxCharsPerMessage') ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
      });
    },

    subagentsList: async (args) => {
      return await hostSubagentStore.list(args);
    },

    subagentsGet: async (args) => {
      return await hostSubagentStore.get(args);
    },

    subagentsWatch: async (args) => {
      try {
        return await new Promise((resolve, reject) => {
          try {
            let subscription: Readonly<{ unsubscribe(): void }> | null = null;
            let unsubscribeAfterRegister = false;
            subscription = hostSubagentStore.watch(args, (event) => {
              if (event.kind !== 'snapshot') return;
              resolve({
                kind: 'snapshot',
                subagents: event.subagents ?? [],
              });
              if (subscription) {
                subscription.unsubscribe();
              } else {
                unsubscribeAfterRegister = true;
              }
            });
            if (unsubscribeAfterRegister) {
              subscription.unsubscribe();
            }
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpsert: async (input) => {
      try {
        return await hostSubagentStore.upsert({
          actor: { kind: 'externalRpc' },
          input,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpdateStatus: async (args) => {
      try {
        return await hostSubagentStore.updateStatus({
          actor: { kind: 'externalRpc' },
          ...args,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsComplete: async (args) => {
      try {
        return await hostSubagentStore.complete({
          actor: { kind: 'externalRpc' },
          ...args,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    pluginsDevLoopAction: async ({ actionId, input }) => await executePluginDevLoopAction({
      actionId,
      input,
      happyHomeDir: params.happyHomeDir,
      workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
    }),

    buildApprovalPreview: async ({ actionId, input, defaultPreview }) => {
      if (actionId === 'plugins.install') {
        return await buildPluginInstallApprovalPreview({
          input,
          defaultPreview,
          workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
        });
      }
      return defaultPreview;
    },

    resetGlobalVoiceAgent: () => {},
  };
}
