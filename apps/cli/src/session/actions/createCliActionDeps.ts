import { homedir } from 'node:os';

import {
  buildBackendTargetKey,
  getActionSpec,
  listNativeReviewEngines,
  parseBackendTargetKey,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  buildStructuredQuestionAnswerPayload,
  type ActionExecutorDeps,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  getProviderCliRuntimeSpec,
  parsePermissionIntentAlias,
  readMetadataAliasValue,
  readNewestSessionModelsMetadataStateV1,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { createCliApprovalsArtifactStore } from '@/approvals/cliApprovalsArtifactStore';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import {
  agentSupportsSpawnConnectedServicesDefaults,
  resolveSpawnConnectedServicesDefaults,
} from '@/session/services/spawnConnectedServicesDefaults';
import { getSessionEvents } from '@/session/services/getSessionEvents';
import { getSessionHistory } from '@/session/services/getSessionHistory';
import { getSessionRecentMessages } from '@/session/services/getSessionRecentMessages';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
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
}>) => void;

/**
 * QAE-1: cancels the daemon RUNTIME-AUTH recovery intents for a session when the
 * user cancels wait-resume. Without this, a durable `waiting` runtime-auth intent
 * (group-exhausted/profile-pinned reset wait) stays armed after "Stop waiting"
 * and resumes the session involuntarily at the provider reset time.
 */
export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
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

function readSessionModelsState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readNewestSessionModelsMetadataStateV1(metadata);
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

async function resolveSpawnConnectedServicesDefaultPayload(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  credentials: Credentials;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null> {
  if (params.backendTarget.kind !== 'builtInAgent') return null;
  const agentId = params.backendTarget.agentId;
  if (!AGENT_IDS.includes(agentId as AgentId)) return null;
  if (!agentSupportsSpawnConnectedServicesDefaults(agentId as AgentId)) return null;

  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    const connectedServices = resolveSpawnConnectedServicesDefaults({
      accountSettings: accountSettingsContext.settings,
      agentId: agentId as AgentId,
    });
    if (!connectedServices) return null;
    return {
      connectedServices,
      connectedServicesUpdatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function createCliActionInventoryDeps(params: Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{ metadata?: unknown }> | null;
}>): Pick<ActionExecutorDeps, 'reviewEnginesList' | 'agentsBackendsList' | 'agentsModelsList' | 'sessionModesList'> {
  const metadataCache = new Map<string, Record<string, unknown> | null>();
  const seededMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
  metadataCache.set(params.sessionId, seededMetadata);

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
      const modelState = readSessionModelsState(await readSessionMetadataForId(params.sessionId));
      const provider = typeof modelState?.provider === 'string' ? modelState.provider.trim() : '';
      const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
      const items = provider && provider !== normalizedAgentId
        ? [{ id: 'default', label: 'Default' }]
        : [
            { id: 'default', label: 'Default' },
            ...availableModels
              .map((entry) => {
                const modelId = typeof entry?.id === 'string' ? entry.id.trim() : '';
                if (!modelId) return null;
                const label = typeof entry?.name === 'string' && entry.name.trim().length > 0
                  ? entry.name.trim()
                  : modelId;
                const description = typeof entry?.description === 'string' && entry.description.trim().length > 0
                  ? entry.description.trim()
                  : undefined;
                return {
                  id: modelId,
                  label,
                  ...(description ? { description } : {}),
                };
              })
              .filter(Boolean),
          ];
      const dedupedItems = items.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
      const bounded = normalizeLimit(limit);
      return {
        agentId: normalizedAgentId,
        items: bounded ? dedupedItems.slice(0, bounded) : dedupedItems,
        supportsFreeform: false,
        source: provider && provider === normalizedAgentId ? 'session_metadata' : 'static',
      };
    },
    sessionModesList: async ({ sessionId }) => {
      const sessionModes = readSessionModesState(await readSessionMetadataForId(sessionId));
      const items = Array.isArray(sessionModes?.availableModes)
        ? sessionModes.availableModes
          .map((entry) => {
            const modeId = typeof entry?.id === 'string' ? entry.id.trim() : '';
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
        requestProvider,
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
      params.cancelInactiveSessionUsageLimitRecoveryCheck?.({ sessionId });
    }
  };

  // Forward only a real per-operation choice as the explicit precedence tier;
  // the routed owner resolves stored intent, account setting, group policy, and
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

      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, input);
    },

    daemonMemorySearch: async () => notSupported(),
    daemonMemoryGetWindow: async () => notSupported(),
    daemonMemoryEnsureUpToDate: async () => notSupported(),

    sessionOpen: async () => notSupported(),
    sessionFork: async () => notSupported(),
    sessionRollback: async () => notSupported(),
    sessionSpawnNew: async ({ tag, agentId, modelId, backendTargetKey, title, path, host, initialMessage }) => {
      if (!params.credentials) {
        notSupported();
      }

      const requestedHost = typeof host === 'string' ? host.trim() : '';
      const currentHost = await resolveCurrentSessionValue('host');
      const currentMachineId = await resolveCurrentSessionValue('machineId');

      if (requestedHost) {
        if (!currentHost || requestedHost !== currentHost || !currentMachineId) {
          return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
        }
      }

      const directory = typeof path === 'string' && path.trim().length > 0
        ? path.trim()
        : await resolveCurrentSessionValue('path');
      if (!directory) {
        return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
      }

      const rawBackendTargetKey = typeof backendTargetKey === 'string' ? backendTargetKey.trim() : '';
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';

      const backendTarget = (() => {
        if (rawBackendTargetKey) {
          const parsed = parseBackendTargetKey(rawBackendTargetKey);
          if (!parsed) return null;
          return parsed;
        }
        if (normalizedAgentId) {
          if (!AGENT_IDS.includes(normalizedAgentId as AgentId)) return null;
          return { kind: 'builtInAgent', agentId: normalizedAgentId as AgentId } as const;
        }
        return { kind: 'builtInAgent', agentId: DEFAULT_AGENT_ID } as const;
      })();
      if (!backendTarget) {
        return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }
      if (backendTarget.kind === 'builtInAgent' && normalizedAgentId && !AGENT_IDS.includes(normalizedAgentId as AgentId)) {
        return { type: 'error', errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
      }
      const normalizedTitle = typeof title === 'string' ? title.trim() : '';
      const connectedServicesDefaults = await resolveSpawnConnectedServicesDefaultPayload({
        credentials: params.credentials,
        backendTarget,
      });

      const created = await createSpawnedSession({
        credentials: params.credentials,
        directory,
        ...(currentMachineId ? { machineId: currentMachineId } : {}),
        backendTarget,
        ...(connectedServicesDefaults ?? {}),
        ...(typeof tag === 'string' && tag.trim().length > 0 ? { tag: tag.trim() } : {}),
        ...(normalizedTitle ? { title: normalizedTitle } : {}),
        ...(typeof initialMessage === 'string' && initialMessage.trim().length > 0 ? { initialMessage: initialMessage.trim() } : {}),
        ...(typeof modelId === 'string' && modelId.trim().length > 0 && modelId.trim() !== 'default'
          ? { modelId: modelId.trim() }
          : {}),
      });

      return {
        type: 'success',
        sessionId: created.sessionId,
        created: created.created,
        session: created.session,
      };
    },
    sessionSpawnPicker: async () => notSupported(),
    pathsListRecent: async () => notSupported(),
    machinesList: async () => notSupported(),
    serversList: async () => notSupported(),
    ...(approvalsStore ?? {}),
    ...inventoryDeps,
	    sessionSendMessage: async ({ sessionId, message, wait, timeoutSeconds, permissionModeOverride, modelOverride }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }

	      const normalizedWait = typeof wait === 'boolean' ? wait : false;
	      const normalizedTimeoutSeconds =
	        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
	          ? Math.min(3600, timeoutSeconds)
	          : 300;

	      const res = await sendSessionMessage({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        message: String(message ?? ''),
	        wait: normalizedWait,
	        timeoutMs: normalizedTimeoutSeconds * 1000,
	        ...(typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
	          ? { permissionModeOverride: permissionModeOverride.trim() }
	          : {}),
	        ...(modelOverride === null
	          ? { modelOverride: null }
	          : typeof modelOverride === 'string' && modelOverride.trim().length > 0
	            ? { modelOverride: modelOverride.trim() }
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
      const parsed = parsePermissionIntentAlias(String(permissionMode ?? '').trim());
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

    sessionModelSet: async ({ sessionId, modelId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = String(modelId ?? '').trim();
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

    sessionUsageLimitWaitResumeCancel: async ({ sessionId, issueFingerprint }) => {
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
      };
      const result = await callRoutedUsageLimitRecoveryControl(sessionId, 'cancel', request);
      const rawResult = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      if (rawResult?.ok === true) {
        params.cancelInactiveSessionUsageLimitRecoveryCheck?.({ sessionId });
        // QAE-1: also clear the daemon runtime-auth recovery store — a waiting
        // intent left armed here resumes the session involuntarily at reset.
        // Best-effort: store-cancel failures must not fail the user cancel.
        try {
          await params.cancelConnectedServiceRuntimeAuthRecovery?.({ sessionId });
        } catch {
          // non-fatal; the wiring owner logs its own failures
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
