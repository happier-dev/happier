import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  buildBackendTargetKey,
  getActionSpec,
  listNativeReviewEngines,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  buildStructuredQuestionAnswerPayload,
  type ActionExecutorDeps,
  type BackendTargetRefV1,
  type FeatureId,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import {
  AGENT_IDS,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  assertNonEscalatingPermissionMode,
  getProviderCliRuntimeSpec,
  parsePermissionIntentAlias,
  readMetadataAliasValue,
  resolvePermissionPrivilegeFromSessionMetadata,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { createCliApprovalsArtifactStore } from '@/approvals/cliApprovalsArtifactStore';
import { fetchAccountProfile } from '@/api/accountProfile';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import {
  normalizeSessionAgentSpawnActionRequest,
  resolveSessionAgentSpawnPolicy,
} from '@/session/services/spawn/normalizeSessionAgentSpawnActionRequest';
import { createCliActionOptionProviderRegistry } from '@/session/actions/options/actionOptionProviderRegistry';
import {
  listRecentSpawnPathItems,
  listSpawnMachineItems,
  listSpawnServerItems,
} from '@/session/actions/options/spawnTargetDiscovery';
import { listSpawnProfileItems } from '@/session/actions/options/spawnProfileDiscovery';
import { listSpawnConnectedServiceItems } from '@/session/actions/options/spawnConnectedServiceDiscovery';
import { previewSpawnMcpServers } from '@/session/actions/options/spawnMcpServerDiscovery';
import { getSessionEvents } from '@/session/services/getSessionEvents';
import { getSessionHistory } from '@/session/services/getSessionHistory';
import { getSessionRecentMessages } from '@/session/services/getSessionRecentMessages';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { listSessions } from '@/session/services/listSessions';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
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
  decryptStoredSessionPayload,
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
import {
  normalizeExecutionRunWaitPollIntervalMs,
  normalizeExecutionRunWaitTimeoutMs,
} from '@/session/services/executionRunWaitTiming';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById, fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { buildRoutedResumePromptTierSources } from '@/session/usageLimitRecoveryControls/buildRoutedResumePromptTierSources';
import {
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';
import {
  routeSessionUsageLimitRecoverySwitchAccountNow,
  type NotifyRuntimeAuthFailure,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoverySwitchAccountNow';
import {
  resolveUsageLimitRecoveryFeatureEnabled,
  usageLimitRecoveryFeatureDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';
import { normalizeCliSessionUsageLimitRecoveryOperationResult } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';

export type ResumeInactiveSessionWhenUsageLimitReady = (input: Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>) => Promise<boolean> | boolean;

export type ScheduleInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  recovery: SessionUsageLimitRecoveryV1;
  runCheckNow: () => Promise<unknown>;
}>) => void;

export type CancelInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}>) => void;

/**
 * QAE-1: cancels the daemon RUNTIME-AUTH recovery intents for a session when the
 * user cancels wait-resume. Without this, a durable `waiting` runtime-auth intent
 * (group-exhausted/profile-pinned reset wait) stays armed after "Stop waiting"
 * and resumes the session involuntarily at the provider reset time.
 */
export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
}>) => Promise<unknown> | unknown;

export type NotifyConnectedServiceRuntimeAuthFailure = NotifyRuntimeAuthFailure;

export type RetryTemporaryThrottleNow = (input: Readonly<{
  sessionId: string;
}>) => Promise<unknown> | unknown;

type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;

function normalizeActionToolExposureSurface(surface: unknown): 'session_agent' | 'mcp' | 'cli' {
  return surface === 'session_agent' || surface === 'mcp' || surface === 'cli'
    ? surface
    : 'cli';
}

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildPermissionEscalationDeniedResult(decision: Extract<
  ReturnType<typeof assertNonEscalatingPermissionMode>,
  { ok: false }
>) {
  return {
    ok: false as const,
    errorCode: 'permission_escalation_denied' as const,
    error: 'permission_escalation_denied' as const,
    details: {
      requestedMode: decision.requestedMode,
      requestedOrdinal: decision.requestedOrdinal,
      callerMode: decision.callerMode,
      callerOrdinal: decision.callerOrdinal,
    },
  };
}

function buildInvalidParametersResult() {
  return {
    ok: false as const,
    errorCode: 'invalid_parameters' as const,
    error: 'invalid_parameters' as const,
  };
}

function readSessionMetadata(params: Readonly<{
  rawSession?: Readonly<{ metadata?: unknown }> | null;
  mode?: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): Record<string, unknown> | null {
  const raw = params.rawSession?.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0 || !params.mode) {
    return null;
  }

  try {
    const decrypted = decryptStoredSessionPayload({
      mode: params.mode,
      ctx: params.ctx,
      value: raw,
    });
    return decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
      ? decrypted as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readRawSessionMetadata(params: Readonly<{
  rawSession?: Readonly<{ metadata?: unknown }> | null;
  mode?: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): Record<string, unknown> | null {
  return readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
}

async function readLiveActionAccountSettings(credentials?: Credentials): Promise<Readonly<Record<string, unknown>>> {
  if (!credentials) return {};
  return await bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'auto',
    honorAccountSettingsModeEnv: false,
  })
    .then((ctx) => ctx.settings as Readonly<Record<string, unknown>>)
    .catch(() => ({}));
}

type PendingAgentRequestKind = 'permission' | 'user_action';

function readSessionAgentState(params: Readonly<{
  rawSession?: Readonly<{ agentState?: unknown }> | null;
  mode?: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): Record<string, unknown> | null {
  const raw = params.rawSession?.agentState;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0 || !params.mode) {
    return null;
  }

  try {
    const decrypted = decryptStoredSessionPayload({
      mode: params.mode,
      ctx: params.ctx,
      value: raw,
    });
    return decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
      ? decrypted as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

type CliAgentStateCapability =
  | 'modelScopedConfigTombstonesV1'
  | 'structuredQuestionAnswersV1Supported';

function hasLiteralAgentStateCapability(
  agentState: Record<string, unknown> | null,
  capability: CliAgentStateCapability,
): boolean {
  const capabilities = agentState?.capabilities;
  return Boolean(
    capabilities
    && typeof capabilities === 'object'
    && !Array.isArray(capabilities)
    && (capabilities as Record<string, unknown>)[capability] === true,
  );
}

function resolveOnlyPendingRequestId(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  kind: PendingAgentRequestKind;
}>): string | null {
  const agentState = readSessionAgentState(params);
  const requests = agentState?.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
    return null;
  }

  const matchingIds = Object.entries(requests)
    .filter(([, request]) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
      const requestKind = (request as Record<string, unknown>).kind;
      if (params.kind === 'user_action') return requestKind === 'user_action';
      return requestKind === 'permission' || typeof requestKind === 'undefined';
    })
    .map(([id]) => id.trim())
    .filter((id) => id.length > 0);

  return matchingIds.length === 1 ? matchingIds[0] : null;
}

function resolvePendingRequestKind(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  requestId: string;
}>): PendingAgentRequestKind | null {
  const agentState = readSessionAgentState(params);
  const requests = agentState?.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
    return null;
  }

  const request = (requests as Record<string, unknown>)[params.requestId];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return null;
  }

  const requestKind = (request as Record<string, unknown>).kind;
  return requestKind === 'user_action' ? 'user_action' : 'permission';
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

function permissionRequestNotFoundResult(sessionId: string) {
  return {
    ok: false,
    errorCode: 'permission_request_not_found',
    errorMessage: 'permission_request_not_found',
    sessionId,
  } as const;
}

function readMetadataObjectFromResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

function readUsageLimitRecoveryFromResult(result: unknown): SessionUsageLimitRecoveryV1 | null {
  const metadata = readMetadataObjectFromResult(result);
  if (!metadata) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function shouldScheduleUsageLimitRecoveryCheck(recovery: SessionUsageLimitRecoveryV1): boolean {
  return (
    (recovery.status === 'armed' || recovery.status === 'waiting' || recovery.status === 'checking')
    && typeof recovery.nextCheckAtMs === 'number'
  );
}

function readSessionModesState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readMetadataAliasValue(
    metadata,
    SESSION_MODES_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
  }> | null;
}

function buildAgentBackendItems(params: Readonly<{ limit?: unknown }>): readonly Readonly<{
  targetKey: string;
  label: string;
  enabled: true;
  agentId: AgentId;
}>[] {
  const limit = normalizeLimit(params.limit);
  const items = AGENT_IDS.map((agentId) => ({
    targetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId }),
    label: getProviderCliRuntimeSpec(agentId).title,
    enabled: true as const,
    agentId,
  }));
  return limit ? items.slice(0, limit) : items;
}

export function createCliActionInventoryDeps(params: Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{ metadata?: unknown; path?: unknown }> | null;
}>): Pick<ActionExecutorDeps, 'reviewEnginesList' | 'agentsBackendsList' | 'agentsModelsList' | 'agentsConfigOptionsList' | 'agentsSessionModesList' | 'sessionModesList'> {
  const metadataCache = new Map<string, Record<string, unknown> | null>();
  const seededMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
  metadataCache.set(params.sessionId, seededMetadata);
  const rawPath = typeof params.rawSession?.path === 'string' ? params.rawSession.path.trim() : '';
  const metadataPath = typeof seededMetadata?.path === 'string' ? seededMetadata.path.trim() : '';
  const createOptionRegistry = async () => createCliActionOptionProviderRegistry({
    cwd: rawPath || metadataPath || process.cwd(),
    credentials: params.credentials ?? null,
    accountSettings: await readLiveActionAccountSettings(params.credentials),
  });

  const readSessionMetadataForId = async (sessionId: string): Promise<Record<string, unknown> | null> => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return null;

    if (metadataCache.has(normalizedSessionId)) {
      return metadataCache.get(normalizedSessionId) ?? null;
    }

    try {
      const rawSession = await fetchSessionById({ token: params.token, sessionId: normalizedSessionId });
      const mode =
        normalizedSessionId === params.sessionId && params.mode
          ? params.mode
          : resolveSessionStoredContentEncryptionMode(rawSession ?? undefined);
      const rawMetadata = rawSession?.metadata;
      const metadataRequiresDecryption = typeof rawMetadata === 'string' && rawMetadata.trim().length > 0;
      const ctx =
        metadataRequiresDecryption && normalizedSessionId !== params.sessionId && params.credentials
          ? resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession ?? undefined)
          : params.ctx;
      const metadata = readSessionMetadata({ rawSession, mode, ctx });
      metadataCache.set(normalizedSessionId, metadata);
      return metadata;
    } catch {
      metadataCache.set(normalizedSessionId, null);
      return null;
    }
  };

  return {
    reviewEnginesList: async ({ sessionId }) => ({
      sessionId,
      items: listNativeReviewEngines().map((engine) => ({
        engineId: engine.id,
        label: engine.title,
        enabled: true,
      })),
    }),
    agentsBackendsList: async (args) => ({
      items: buildAgentBackendItems({ limit: (args as { limit?: unknown }).limit }),
    }),
    agentsModelsList: async (args) => {
      const agentId = args.agentId;
      const limit = (args as { limit?: unknown }).limit;
      const normalizedAgentId = String(agentId ?? '').trim();
      const backendTargetKey = typeof (args as { backendTargetKey?: unknown }).backendTargetKey === 'string'
        ? (args as { backendTargetKey: string }).backendTargetKey
        : undefined;
      const optionRegistry = await createOptionRegistry();
      return await optionRegistry.agentsModelsList({
        agentId: normalizedAgentId,
        ...(backendTargetKey ? { backendTargetKey } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    agentsConfigOptionsList: async (args) => {
      const limit = (args as { limit?: unknown }).limit;
      const normalizedAgentId = String(args.agentId ?? '').trim();
      const backendTargetKey = typeof (args as { backendTargetKey?: unknown }).backendTargetKey === 'string'
        ? (args as { backendTargetKey: string }).backendTargetKey
        : undefined;
      const modelId = typeof (args as { modelId?: unknown }).modelId === 'string'
        ? readNonBlankSessionControlIdentifier((args as { modelId: string }).modelId) ?? ''
        : '';
      const optionRegistry = await createOptionRegistry();
      return await optionRegistry.agentsConfigOptionsList({
        agentId: normalizedAgentId,
        ...(backendTargetKey ? { backendTargetKey } : {}),
        ...(modelId ? { modelId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    agentsSessionModesList: async (args) => {
      const limit = (args as { limit?: unknown }).limit;
      const normalizedAgentId = String(args.agentId ?? '').trim();
      const backendTargetKey = typeof (args as { backendTargetKey?: unknown }).backendTargetKey === 'string'
        ? (args as { backendTargetKey: string }).backendTargetKey
        : undefined;
      const optionRegistry = await createOptionRegistry();
      return await optionRegistry.agentsSessionModesList({
        agentId: normalizedAgentId,
        ...(backendTargetKey ? { backendTargetKey } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    sessionModesList: async ({ sessionId }) => {
      const sessionModes = readSessionModesState(await readSessionMetadataForId(sessionId));
      const items = Array.isArray(sessionModes?.availableModes)
        ? sessionModes.availableModes
          .map((entry) => {
            const modeId = readNonBlankSessionControlIdentifier(entry?.id) ?? '';
            if (!modeId) return null;
            const label = typeof entry?.name === 'string' && entry.name.trim().length > 0
              ? entry.name.trim()
              : modeId;
            const description = typeof entry?.description === 'string' && entry.description.trim().length > 0
              ? entry.description.trim()
              : undefined;
            return {
              id: modeId,
              label,
              ...(description ? { description } : {}),
            };
          })
          .filter(Boolean)
        : [];
      return { sessionId, items };
    },
  };
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
  getCurrentSessionBackendTarget?: (() => BackendTargetRefV1 | null | undefined) | null;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  notifyConnectedServiceRuntimeAuthFailure?: NotifyConnectedServiceRuntimeAuthFailure;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
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

  const sessionTransportCache = new Map<string, ResolvedSessionTransport>();
  let usageLimitRecoveryFeatureEnabledPromise: Promise<boolean> | null = null;
  let accountProfilePromise: Promise<Awaited<ReturnType<typeof fetchAccountProfile>> | null> | null = null;
  const actionFeatureDecisionPromises = new Map<FeatureId, Promise<boolean>>();
  const ambiguousSpawnActionRequestIds = new Set<string>();

  const resolveActionFeatureEnabled = async (featureId: FeatureId): Promise<boolean> => {
    const cached = actionFeatureDecisionPromises.get(featureId);
    if (cached) return await cached;
    const promise = resolveCliFeatureDecisionForServer({
      featureId,
      env: process.env,
      serverUrl: resolveServerHttpBaseUrl(),
      timeoutMs: 800,
    })
      .then((resolved) => resolved.decision.state === 'enabled')
      .catch(() => false);
    actionFeatureDecisionPromises.set(featureId, promise);
    return await promise;
  };

  const readActionAccountSettings = async (): Promise<Readonly<Record<string, unknown>>> => {
    return await readLiveActionAccountSettings(params.credentials);
  };

  const readActionAccountProfile = async (): Promise<Awaited<ReturnType<typeof fetchAccountProfile>> | null> => {
    if (!params.credentials) return null;
    accountProfilePromise ??= fetchAccountProfile({ token: params.credentials.token }).catch(() => null);
    return await accountProfilePromise;
  };

  const fetchCurrentSessionMetadata = async (): Promise<Record<string, unknown> | null> => {
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

  const readCurrentSessionMetadata = async (): Promise<Record<string, unknown> | null> => {
    currentSessionMetadata ??= readRawSessionMetadata({
      rawSession: params.rawSession,
      mode: params.mode,
      ctx: params.ctx,
    });
    if (currentSessionMetadata) return currentSessionMetadata;
    return await fetchCurrentSessionMetadata();
  };

  const readFreshCurrentSessionMetadata = async (): Promise<Record<string, unknown> | null> => {
    const rawSessionMetadata = readRawSessionMetadata({
      rawSession: params.rawSession,
      mode: params.mode,
      ctx: params.ctx,
    });
    if (rawSessionMetadata) {
      currentSessionMetadata = rawSessionMetadata;
      return rawSessionMetadata;
    }
    return await fetchCurrentSessionMetadata();
  };

  const readValidPermissionMode = (value: unknown): string | null => {
    const liveMode = normalizeString(value);
    return liveMode && parsePermissionIntentAlias(liveMode) ? liveMode : null;
  };

  const readLiveCallerPermissionMode = (): string | null => readValidPermissionMode(params.getCallerPermissionMode?.());

  const denyPermissionEscalationForRequestedMode = async (
    requestedMode: unknown,
  ): Promise<ReturnType<typeof buildPermissionEscalationDeniedResult> | ReturnType<typeof buildInvalidParametersResult> | null> => {
    const normalizedRequestedMode = normalizeString(requestedMode);
    if (!normalizedRequestedMode) return null;
    if (!parsePermissionIntentAlias(normalizedRequestedMode)) {
      return buildInvalidParametersResult();
    }

    const callerMode = readLiveCallerPermissionMode()
      ?? resolvePermissionPrivilegeFromSessionMetadata(await readFreshCurrentSessionMetadata()).mode;
    const permissionDecision = assertNonEscalatingPermissionMode({
      requestedMode: normalizedRequestedMode,
      callerMode,
    });
    return permissionDecision.ok ? null : buildPermissionEscalationDeniedResult(permissionDecision);
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

  const resolveTransportForSession = async (idOrPrefix: string): Promise<Readonly<{
    ok: true;
    sessionId: string;
    rawSession: RawSessionRecord;
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

  const callResolvedSessionRpc = async (
    sessionId: string,
    methodSuffix: string,
    request: unknown,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return {
        ok: false,
        errorCode: transport.code,
        error: transport.code,
        ...(transport.candidates ? { candidates: transport.candidates } : {}),
      };
    }

    return await callSessionRpcForTransport(transport, methodSuffix, request);
  };

  let currentMachineControlIdentityPromise: Promise<CurrentMachineControlIdentity> | null = null;

  const readCurrentMachineControlIdentity = async (): Promise<CurrentMachineControlIdentity> => {
    currentMachineControlIdentityPromise ??= (async () => {
      let machineId: string | null = null;
      try {
        machineId = normalizeString((await readSettings()).machineId);
      } catch {
        machineId = null;
      }

      let host: string | null = null;
      try {
        host = normalizeString(await getPreferredHostName());
      } catch {
        host = null;
      }

      return {
        machineId,
        host,
        homeDir: normalizeString(homedir()),
      };
    })();
    return await currentMachineControlIdentityPromise;
  };

  const callRoutedSessionGoalControl = async (
    sessionId: string,
    operation: 'get' | 'set' | 'clear',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return {
        ok: false,
        errorCode: transport.code,
        error: transport.code,
        ...(transport.candidates ? { candidates: transport.candidates } : {}),
      };
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
    const method = operation === 'vendorPlugins'
      ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST
      : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
    const rpcRequest = {
      ...(typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? { cwd: request.cwd.trim() } : {}),
    };
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
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
      return normalizeCliSessionUsageLimitRecoveryOperationResult({
        sessionId,
        result: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
      });
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeCliSessionUsageLimitRecoveryOperationResult({
        sessionId,
        result: {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
      });
    }

    const metadata = readSessionMetadata({
      rawSession: transport.rawSession,
      mode: transport.mode,
      ctx: transport.ctx,
    });

    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    const requestProvider = typeof request.provider === 'string' ? request.provider : null;
    const routeParams = {
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
      resumePromptTierSources: buildRoutedResumePromptTierSources({
        credentials: params.credentials,
        metadata,
        rawSession: transport.rawSession,
      }),
      ...(params.resumeInactiveSessionWhenUsageLimitReady
        ? { resumeInactiveSessionWhenReady: params.resumeInactiveSessionWhenUsageLimitReady }
        : {}),
      ...(params.retryTemporaryThrottleNow
        ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
        : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        operation === 'enable'
          ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
          : operation === 'cancel'
            ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
            : SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        request,
      ),
    } as const;

    if (operation === 'enable') {
      return await routeSessionUsageLimitRecoveryWaitResumeEnable({
        ...routeParams,
        request: request as {
          sessionId: string;
          issueFingerprint?: string;
          remember?: boolean;
          rememberPreference?: boolean;
          resumePromptMode?: 'standard' | 'off' | 'custom';
        },
      });
    }
    if (operation === 'cancel') {
      return await routeSessionUsageLimitRecoveryWaitResumeCancel({
        ...routeParams,
        request: request as { sessionId: string; issueFingerprint?: string | null },
      });
    }
    if (operation === 'switchAccountNow') {
      return await routeSessionUsageLimitRecoverySwitchAccountNow({
        ...routeParams,
        request: request as { sessionId: string; provider?: string; resumePromptMode?: 'standard' | 'off' | 'custom' },
        ...(params.notifyConnectedServiceRuntimeAuthFailure
          ? { notifyRuntimeAuthFailure: params.notifyConnectedServiceRuntimeAuthFailure }
        : {}),
      });
    }
    return await routeSessionUsageLimitRecoveryCheckNow({
      ...routeParams,
      request: request as {
        sessionId: string;
        provider?: string;
        operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
        resumePromptMode?: 'standard' | 'off' | 'custom';
      },
    });
  };

  const usageLimitRecoveryFeatureEnabled = async (): Promise<boolean> => {
    usageLimitRecoveryFeatureEnabledPromise ??= resolveUsageLimitRecoveryFeatureEnabled();
    return await usageLimitRecoveryFeatureEnabledPromise;
  };

  const scheduleUsageLimitRecoveryCheckFromResult = (
    sessionId: string,
    result: unknown,
  ): void => {
    const recovery = readUsageLimitRecoveryFromResult(result);
    if (!recovery) return;
    if (shouldScheduleUsageLimitRecoveryCheck(recovery)) {
      params.scheduleInactiveSessionUsageLimitRecoveryCheck?.({
        sessionId,
        recovery,
        // No explicit mode: the stored intent supplies the resume prompt mode
        // at its own precedence tier when the routed check runs.
        runCheckNow: async () => await runUsageLimitCheckNow({ sessionId }),
      });
      return;
    }
    if (recovery.status === 'cancelled' || recovery.status === 'exhausted') {
      params.cancelInactiveSessionUsageLimitRecoveryCheck?.({
        sessionId,
        issueFingerprint: recovery.issueFingerprint,
        armedAtMs: recovery.armedAtMs,
        ...(recovery.runtimeAuthRecoveryAttemptId
          ? { runtimeAuthRecoveryAttemptId: recovery.runtimeAuthRecoveryAttemptId }
          : {}),
      });
    }
  };

  // Forward only a real per-operation choice as the explicit precedence tier;
  // the routed owner resolves stored intent, group policy, account setting, and
  // provider config when no explicit value was requested (RD-REC-5).
  const readExplicitUsageLimitRecoveryResumePromptMode = (
    explicit?: 'standard' | 'off' | 'custom',
  ): 'standard' | 'off' | 'custom' | undefined => (
    explicit === 'standard' || explicit === 'off' || explicit === 'custom' ? explicit : undefined
  );

  const runUsageLimitCheckNow = async (
    input: Readonly<{ sessionId: string; provider?: string; resumePromptMode?: 'standard' | 'off' | 'custom' }>,
  ): Promise<unknown> => {
    const normalizedProvider = typeof input.provider === 'string' ? input.provider.trim() : '';
    const resumePromptMode = readExplicitUsageLimitRecoveryResumePromptMode(input.resumePromptMode);
    const result = await callRoutedUsageLimitRecoveryControl(input.sessionId, 'checkNow', {
      sessionId: input.sessionId,
      ...(normalizedProvider.length > 0 ? { provider: normalizedProvider } : {}),
      ...(resumePromptMode ? { resumePromptMode } : {}),
    });
    scheduleUsageLimitRecoveryCheckFromResult(input.sessionId, result);
    return result;
  };

  const runUsageLimitSwitchAccountNow = async (
    input: Readonly<{ sessionId: string; provider?: string; resumePromptMode?: 'standard' | 'off' | 'custom' }>,
  ): Promise<unknown> => {
    const normalizedProvider = typeof input.provider === 'string' ? input.provider.trim() : '';
    const resumePromptMode = readExplicitUsageLimitRecoveryResumePromptMode(input.resumePromptMode);
    return await callRoutedUsageLimitRecoveryControl(input.sessionId, 'switchAccountNow', {
      sessionId: input.sessionId,
      ...(normalizedProvider.length > 0 ? { provider: normalizedProvider } : {}),
      ...(resumePromptMode ? { resumePromptMode } : {}),
    });
  };

  const runUsageLimitConsumeResetCredit = async (
    input: Readonly<{ sessionId: string; provider?: string; resumePromptMode?: 'standard' | 'off' | 'custom' }>,
  ): Promise<unknown> => {
    const normalizedProvider = typeof input.provider === 'string' ? input.provider.trim() : '';
    const resumePromptMode = readExplicitUsageLimitRecoveryResumePromptMode(input.resumePromptMode);
    return await callRoutedUsageLimitRecoveryControl(input.sessionId, 'consumeResetCredit', {
      sessionId: input.sessionId,
      ...(normalizedProvider.length > 0 ? { provider: normalizedProvider } : {}),
      operation: 'consume_reset_credit',
      ...(resumePromptMode ? { resumePromptMode } : {}),
    });
  };

  return {
    executionRunStart: async (sessionId, request) => {
      const permissionDenied = await denyPermissionEscalationForRequestedMode(request.permissionMode);
      if (permissionDenied) return permissionDenied;

      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      if (transport.rawSession.active !== true) {
        if (!params.credentials) {
          return { ok: false, code: 'not_authenticated' };
        }
        const metadata = readSessionMetadata({ ...transport, rawSession: transport.rawSession }) ?? {};
        const resumed = await requestInactiveSessionResume({
          credentials: params.credentials,
          sessionId: transport.sessionId,
          localId: `execution.run.start:${randomUUID()}`,
          rawSession: transport.rawSession,
          metadata,
          waitForReady: true,
        });
        if (!resumed.ok) {
          return {
            ok: false,
            code: 'execution_run_target_unavailable',
            message: resumed.message,
          };
        }
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

      const pollIntervalEnvRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
      const pollIntervalMs =
        typeof (request as any)?.pollIntervalMs === 'number'
          ? normalizeExecutionRunWaitPollIntervalMs((request as any).pollIntervalMs)
          : normalizeExecutionRunWaitPollIntervalMs(pollIntervalEnvRaw);

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
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const permissionDenied = await denyPermissionEscalationForRequestedMode(input.permissionMode);
      if (permissionDenied) return permissionDenied;

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
      backend,
      target,
      modelId,
      backendTargetKey,
      backendTarget,
      title,
      path,
      directory,
      host,
      machineId,
      prompt,
      initialPrompt,
      initialMessage,
      permissionMode,
      agentModeId,
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
      codexBackendMode,
      agentRuntimeDescriptorV1,
      surface,
      callerSurface,
      callerPermissionMode,
      actionRequestId,
      resumeActionRequest,
    }) => {
      if (!params.credentials) {
        notSupported();
      }

      const toolSurface = normalizeActionToolExposureSurface(surface ?? callerSurface);
      const currentCallerPermissionMode = toolSurface === 'session_agent'
        ? readValidPermissionMode(callerPermissionMode) ?? readLiveCallerPermissionMode()
        : null;
      const spawnPolicy = toolSurface === 'session_agent'
        ? await resolveSessionAgentSpawnPolicy({ credentials: params.credentials })
        : null;
      const normalized = await normalizeSessionAgentSpawnActionRequest({
        credentials: params.credentials,
        surface: toolSurface,
        input: {
          tag,
          agentId,
          backend,
          target,
          modelId,
          backendTargetKey,
          backendTarget,
          title,
          path,
          directory,
          host,
          machineId,
          prompt,
          initialPrompt,
          initialMessage,
          permissionMode,
          agentModeId,
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
          codexBackendMode,
          agentRuntimeDescriptorV1,
        },
        parentMetadata: await readFreshCurrentSessionMetadata(),
        currentSession: {
          path: await resolveCurrentSessionValue('path'),
          host: await resolveCurrentSessionValue('host'),
          machineId: await resolveCurrentSessionValue('machineId'),
          backendTarget: params.getCurrentSessionBackendTarget?.() ?? null,
          permissionMode: currentCallerPermissionMode,
        },
        spawnPolicy,
      });
      if (!normalized.ok) return normalized.result;

      const normalizedActionRequestId = readNonBlankSessionControlIdentifier(actionRequestId);
      const spawnNonce = normalizedActionRequestId
        ? `session.spawn_new:${params.sessionId}:${normalizedActionRequestId}`
        : null;
      const resumeOnly = Boolean(
        spawnNonce
        && (resumeActionRequest === true || ambiguousSpawnActionRequestIds.has(spawnNonce)),
      );
      if (spawnNonce && !resumeOnly) {
        ambiguousSpawnActionRequestIds.add(spawnNonce);
      }

      let created: Awaited<ReturnType<typeof createSpawnedSession>>;
      try {
        created = await createSpawnedSession({
          ...normalized.createParams,
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
        if (spawnNonce && ambiguousNonce !== spawnNonce) {
          ambiguousSpawnActionRequestIds.delete(spawnNonce);
        }
        throw error;
      }
      if (spawnNonce) {
        ambiguousSpawnActionRequestIds.delete(spawnNonce);
      }

      return {
        type: 'success',
        sessionId: created.sessionId,
        created: created.created,
        session: created.session,
      };
    },
    sessionSpawnPicker: async () => notSupported(),
    pathsListRecent: async ({ machineId, limit }) => {
      if (!params.credentials) return { items: [] };
      return await listRecentSpawnPathItems({ credentials: params.credentials, machineId, limit });
    },
    machinesList: async ({ limit }) => await listSpawnMachineItems({ limit }),
    serversList: async ({ limit }) => await listSpawnServerItems({ limit }),
    sessionsSpawnProfilesList: async ({ agentId, backendTargetKey, includeDisabled, limit }) => {
      if (!params.credentials) return { items: [] };
      return listSpawnProfileItems({
        accountSettings: await readActionAccountSettings(),
        ...(agentId ? { agentId } : {}),
        ...(backendTargetKey ? { backendTargetKey } : {}),
        includeDisabled: includeDisabled === true,
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    sessionsSpawnConnectedServicesList: async ({ agentId, includeUnavailable, limit }) => {
      if (!params.credentials) return { items: [] };
      const connectedServicesFeatureEnabled = await resolveActionFeatureEnabled('connectedServices');
      if (!connectedServicesFeatureEnabled) return { items: [] };
      const accountGroupsFeatureEnabled = await resolveActionFeatureEnabled('connectedServices.accountGroups');
      const accountProfile = await readActionAccountProfile();
      if (!accountProfile) return { items: [] };
      return listSpawnConnectedServiceItems({
        accountSettings: await readActionAccountSettings(),
        accountProfile,
        ...(agentId ? { agentId } : {}),
        connectedServicesFeatureEnabled,
        accountGroupsFeatureEnabled,
        includeUnavailable: includeUnavailable === true,
        ...(typeof limit === 'number' ? { limit } : {}),
      });
    },
    sessionsSpawnMcpServersPreview: async ({ agentId, machineId, path, directory, mcpSelection, selection, limit }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'internal_error', error: 'missing_credentials' };
      }
      const currentMachine = await readCurrentMachineControlIdentity();
      const resolvedMachineId = normalizeString(machineId) ?? currentMachine.machineId;
      const resolvedDirectory = normalizeString(directory) ?? normalizeString(path) ?? await resolveCurrentSessionValue('path') ?? process.cwd();
      if (!resolvedMachineId) {
        return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
      }
      return await previewSpawnMcpServers({
        accountSettings: await readActionAccountSettings(),
        machineId: resolvedMachineId,
        directory: resolvedDirectory,
        ...(agentId ? { agentId } : {}),
        selection: selection ?? mcpSelection ?? null,
        ...(typeof limit === 'number' ? { limit } : {}),
        env: process.env,
      });
    },
    ...(approvalsStore ?? {}),
    ...inventoryDeps,
    sessionSendMessage: async ({ sessionId, message, requestedAction, wait, timeoutSeconds, permissionModeOverride, modelOverride }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedWait = typeof wait === 'boolean' ? wait : false;
      const normalizedTimeoutSeconds =
        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? Math.min(3600, timeoutSeconds)
          : 300;
      const normalizedPermissionModeOverride = normalizeString(permissionModeOverride);
      if (normalizedPermissionModeOverride) {
        const permissionDenied = await denyPermissionEscalationForRequestedMode(normalizedPermissionModeOverride);
        if (permissionDenied) {
          return permissionDenied;
        }
      }

      const res = await sendSessionMessage({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        message: String(message ?? ''),
        requestedAction,
        wait: normalizedWait,
        timeoutMs: normalizedTimeoutSeconds * 1000,
        ...(normalizedPermissionModeOverride
          ? { permissionModeOverride: normalizedPermissionModeOverride }
          : {}),
        ...(modelOverride === null
          ? { modelOverride: null }
          : typeof modelOverride === 'string' && modelOverride.trim().length > 0
            ? { modelOverride }
            : {}),
      });
      if (!res.ok) {
        return {
          ok: false,
          errorCode: res.code,
          error: res.code,
          ...(res.candidates ? { candidates: res.candidates } : {}),
          ...(res.message ? { message: res.message } : {}),
        };
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

    sessionPermissionModeSet: async ({ sessionId, permissionMode }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedPermissionMode = String(permissionMode ?? '').trim();
      const parsed = parsePermissionIntentAlias(normalizedPermissionMode);
      if (!parsed) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const permissionDenied = await denyPermissionEscalationForRequestedMode(normalizedPermissionMode);
      if (permissionDenied) {
        return permissionDenied;
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

    sessionModelSet: async ({ sessionId, modelId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = readNonBlankSessionControlIdentifier(modelId) ?? '';
      if (!normalizedModelId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      const agentState = readSessionAgentState({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
      });
      const updatedAt = Date.now();
      const res = await setSessionModel({
        credentials: params.credentials,
        idOrPrefix: transport.sessionId,
        modelId: normalizedModelId,
        updatedAt,
        retireModelScopedConfigOverrides: hasLiteralAgentStateCapability(
          agentState,
          'modelScopedConfigTombstonesV1',
        ),
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, modelId: normalizedModelId, updatedAt };
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

    sessionVendorPluginCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'vendorPlugins', { cwd });
    },

    sessionSkillCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'skills', { cwd });
    },

    sessionUsageLimitWaitResumeEnable: async ({ sessionId, issueFingerprint, remember, resumePromptMode }) => {
      if (!await usageLimitRecoveryFeatureEnabled()) {
        return usageLimitRecoveryFeatureDisabledResult({ sessionId });
      }
      const explicitResumePromptMode = readExplicitUsageLimitRecoveryResumePromptMode(resumePromptMode);
      const request = {
        sessionId,
        ...(typeof issueFingerprint === 'string' && issueFingerprint.trim().length > 0
          ? { issueFingerprint: issueFingerprint.trim() }
          : {}),
        ...(remember === true ? { remember: true } : {}),
        ...(explicitResumePromptMode ? { resumePromptMode: explicitResumePromptMode } : {}),
      };
      const result = await callRoutedUsageLimitRecoveryControl(sessionId, 'enable', request);
      scheduleUsageLimitRecoveryCheckFromResult(sessionId, result);
      return result;
    },

    sessionUsageLimitWaitResumeCancel: async ({ sessionId, issueFingerprint, armedAtMs, runtimeAuthRecoveryAttemptId }) => {
      if (!await usageLimitRecoveryFeatureEnabled()) {
        return usageLimitRecoveryFeatureDisabledResult({ sessionId });
      }
      const normalizedIssueFingerprint = typeof issueFingerprint === 'string' ? issueFingerprint.trim() : issueFingerprint;
      const request = {
        sessionId,
        ...(typeof normalizedIssueFingerprint === 'string' && normalizedIssueFingerprint.length > 0
          ? { issueFingerprint: normalizedIssueFingerprint }
          : normalizedIssueFingerprint === null
            ? { issueFingerprint: null }
            : {}),
        ...(typeof armedAtMs === 'number' && Number.isFinite(armedAtMs) ? { armedAtMs: Math.trunc(armedAtMs) } : {}),
        ...(typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0
          ? { runtimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId.trim() }
          : {}),
      };
      const result = await callRoutedUsageLimitRecoveryControl(sessionId, 'cancel', request);
      const rawResult = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      if (rawResult?.ok === true) {
        if (typeof normalizedIssueFingerprint !== 'string' || typeof armedAtMs !== 'number') return result;
        const exactAttempt = {
          sessionId,
          issueFingerprint: normalizedIssueFingerprint,
          armedAtMs: Math.trunc(armedAtMs),
          ...(typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0
            ? { runtimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId.trim() }
            : {}),
        };
        params.cancelInactiveSessionUsageLimitRecoveryCheck?.(exactAttempt);
        if (typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0) {
          // Runtime-auth attempts have their own immutable identity. Their armedAt
          // timestamp is sampled independently and is not an exact-match key.
          try {
            await params.cancelConnectedServiceRuntimeAuthRecovery?.({
              sessionId,
              attemptId: runtimeAuthRecoveryAttemptId.trim(),
            });
          } catch {
            // non-fatal; the wiring owner logs its own failures
          }
        }
      }
      return result;
    },

    sessionUsageLimitCheckNow: async ({ sessionId, provider, resumePromptMode }) => {
      if (!await usageLimitRecoveryFeatureEnabled()) {
        return usageLimitRecoveryFeatureDisabledResult({ sessionId });
      }
      return await runUsageLimitCheckNow({
        sessionId,
        ...(typeof provider === 'string' ? { provider } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
      });
    },

    sessionUsageLimitSwitchAccountNow: async ({ sessionId, provider, resumePromptMode }) => {
      if (!await usageLimitRecoveryFeatureEnabled()) {
        return usageLimitRecoveryFeatureDisabledResult({ sessionId });
      }
      return await runUsageLimitSwitchAccountNow({
        sessionId,
        ...(typeof provider === 'string' ? { provider } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
      });
    },

    sessionUsageLimitConsumeResetCredit: async ({ sessionId, provider, resumePromptMode }) => {
      if (!await usageLimitRecoveryFeatureEnabled()) {
        return usageLimitRecoveryFeatureDisabledResult({ sessionId });
      }
      return await runUsageLimitConsumeResetCredit({
        sessionId,
        ...(typeof provider === 'string' ? { provider } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
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
      includeStructuredPayload,
      includeRaw,
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
        ...(cursor !== undefined ? { cursor: cursor ?? null } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(includeTools === true ? { includeTools: true } : {}),
        ...(includeReasoning === true ? { includeReasoning: true } : {}),
        ...(includeEvents === true ? { includeEvents: true } : {}),
        ...(includeMeta === true ? { includeMeta: true } : {}),
        ...(includeStructuredPayload === true ? { includeStructuredPayload: true } : {}),
        ...(includeRaw === true ? { includeRaw: true } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
        ...(maxRawPayloadChars !== undefined ? { maxRawPayloadChars: maxRawPayloadChars ?? null } : {}),
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
      includeStructuredPayload,
      includeRaw,
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
        ...(cursor !== undefined ? { cursor: cursor ?? null } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(kinds ? { kinds } : {}),
        ...(format ? { format } : {}),
        ...(includeMeta === true ? { includeMeta: true } : {}),
        ...(includeStructuredPayload === true ? { includeStructuredPayload: true } : {}),
        ...(includeRaw === true ? { includeRaw: true } : {}),
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        ...(typeof maxPayloadChars === 'number' ? { maxPayloadChars } : {}),
      });
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
	      return await getSessionHistory({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        limit: normalizedLimit,
	        format: normalizedFormat,
	        includeMeta: includeMeta === true,
	        includeStructuredPayload: includeStructuredPayload === true,
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

    sessionPermissionRespond: async ({ sessionId, decision, requestId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
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

      const explicitRequestId = String(requestId ?? '').trim();
      if (explicitRequestId && isKnownCompletedRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: explicitRequestId,
        kind: 'permission',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      // A permission decision must not resolve a pending user-action (AskUserQuestion / ExitPlanMode).
      // Approving one answer-less would silently complete an interactive request with no answers.
      if (explicitRequestId && resolvePendingRequestKind({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: explicitRequestId,
      }) === 'user_action') {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const reqId = explicitRequestId || resolveOnlyPendingRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        kind: 'permission',
      });
      if (!reqId) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const approved = decision === 'allow';
      try {
        return await callSessionRpc({
          token: params.credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
          mode: transport.mode,
          method: `${transport.sessionId}:permission`,
          request: { id: reqId, approved },
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
    sessionUserActionAnswer: async ({ sessionId, requestId, answers, decision, reason, updatedPermissions }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
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

      const explicitRequestId = String(requestId ?? '').trim();
      if (explicitRequestId && isKnownCompletedRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: explicitRequestId,
        kind: 'user_action',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      // A user-action answer must not resolve a plain permission request.
      if (explicitRequestId && resolvePendingRequestKind({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        requestId: explicitRequestId,
      }) === 'permission') {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const reqId = explicitRequestId || resolveOnlyPendingRequestId({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
        kind: 'user_action',
      });
      if (!reqId) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }

      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim()) normalizedAnswers[question] = [...entry.values];
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const approved = decision ? decision === 'approve' : true;
      const agentState = readSessionAgentState({
        rawSession: transport.rawSession,
        mode: transport.mode,
        ctx: transport.ctx,
      });
      const supportsV1 = hasLiteralAgentStateCapability(
        agentState,
        'structuredQuestionAnswersV1Supported',
      );
      const answerPayload = Object.keys(normalizedAnswers).length > 0
        ? buildStructuredQuestionAnswerPayload(normalizedAnswers, supportsV1)
        : null;
      if (answerPayload?.kind === 'requires_cli_update') {
        return {
          ok: false,
          errorCode: 'cli_update_required',
          errorMessage: 'cli_update_required',
          sessionId: transport.sessionId,
        };
      }
      try {
        return await callSessionRpc({
          token: params.credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
          mode: transport.mode,
          method: `${transport.sessionId}:${answerPayload?.send.protocol === 'structured-question-v1'
            ? SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1
            : SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY}`,
          request: answerPayload?.send.protocol === 'structured-question-v1'
            ? { id: reqId, structuredAnswersV1: answerPayload.send.structuredAnswersV1 }
            : {
                id: reqId,
                approved,
                ...(answerPayload?.send.protocol === 'legacy-permission' ? { answers: answerPayload.send.answers } : {}),
                ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
                ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
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

      const normalizedModeId = readNonBlankSessionControlIdentifier(modeId) ?? '';
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

    sessionList: async (args) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { limit, cursor, activeOnly, archivedOnly, includeSystem, resumableOnly, includeLastMessagePreview, includeRows } = args;
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
        includeLastMessagePreview: includeLastMessagePreview === true,
        includeRows: includeRows === true,
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
      return await getSessionRecentMessages({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(Object.prototype.hasOwnProperty.call({ cursor }, 'cursor') ? { cursor: cursor ?? null } : {}),
        ...(typeof includeUser === 'boolean' ? { includeUser } : {}),
        ...(typeof includeAssistant === 'boolean' ? { includeAssistant } : {}),
        ...(Object.prototype.hasOwnProperty.call({ maxCharsPerMessage }, 'maxCharsPerMessage') ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
      });
    },

    resetGlobalVoiceAgent: () => {},
  };
}
