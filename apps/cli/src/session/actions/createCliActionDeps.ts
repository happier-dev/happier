import {
  buildBackendTargetKey,
  getActionSpec,
  listNativeReviewEngines,
  parseBackendTargetKey,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  getProviderCliRuntimeSpec,
  parsePermissionIntentAlias,
  readMetadataAliasValue,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { createCliApprovalsArtifactStore } from '@/approvals/cliApprovalsArtifactStore';
import type { Credentials } from '@/persistence';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { getSessionHistory } from '@/session/services/getSessionHistory';
import { getSessionRecentMessages } from '@/session/services/getSessionRecentMessages';
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
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById, fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
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
  return readMetadataAliasValue(
    metadata,
    SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
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
      const rawMetadata = (rawSession as any)?.metadata;
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
}>): ActionExecutorDeps {
  const inventoryDeps = createCliActionInventoryDeps(params);
  const approvalsStore = params.credentials ? createCliApprovalsArtifactStore({ credentials: params.credentials }) : null;
  let currentSessionMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });
  const sessionTransportCache = new Map<string, Readonly<{
    sessionId: string;
    rawSession: any;
    ctx: SessionEncryptionContext;
    mode: SessionStoredContentEncryptionMode;
  }>>();

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
    if (sessionTransportCache.has(normalized)) {
      return { ok: true, ...(sessionTransportCache.get(normalized) as any) };
    }

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

      const rawTimeoutSeconds = (request as any)?.timeoutSeconds;
      const timeoutSeconds =
        typeof rawTimeoutSeconds === 'number' && Number.isFinite(rawTimeoutSeconds) && rawTimeoutSeconds > 0
          ? Math.min(3600, rawTimeoutSeconds)
          : 300;

      const pollIntervalMsRaw =
        typeof (request as any)?.pollIntervalMs === 'number' && Number.isFinite((request as any).pollIntervalMs) && (request as any).pollIntervalMs > 0
          ? Math.min(60_000, (request as any).pollIntervalMs)
          : null;
      const pollIntervalEnvRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
      const pollIntervalEnvParsed = pollIntervalEnvRaw ? Number.parseInt(pollIntervalEnvRaw, 10) : NaN;
      const pollIntervalEnvMs =
        Number.isFinite(pollIntervalEnvParsed) && pollIntervalEnvParsed > 0 ? Math.min(60_000, pollIntervalEnvParsed) : 1_000;
      const pollIntervalMs = pollIntervalMsRaw ?? pollIntervalEnvMs;

      return await waitForExecutionRun({
        token: params.token,
        sessionId: transport.sessionId,
        mode: transport.mode,
        ctx: transport.ctx,
        runId: String((request as any)?.runId ?? ''),
        timeoutMs: Math.max(1, Math.floor(timeoutSeconds * 1000)),
        pollIntervalMs,
      });
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

      const created = await createSpawnedSession({
        credentials: params.credentials,
        directory,
        ...(currentMachineId ? { machineId: currentMachineId } : {}),
        backendTarget,
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
      const updatedAt = Date.now();
      const res = await setSessionModel({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modelId: normalizedModelId,
        updatedAt,
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

      const normalizedAnswers = Object.fromEntries(
        (Array.isArray(answers) ? answers : [])
          .map((entry: any) => ({
            question: String(entry?.question ?? '').trim(),
            answer: String(entry?.answer ?? '').trim(),
          }))
          .filter((entry) => entry.question.length > 0 && entry.answer.length > 0)
          .map((entry) => [entry.question, entry.answer] as const),
      );
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const approved = decision ? decision === 'approve' : true;
      try {
        return await callSessionRpc({
          token: params.credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
          mode: transport.mode,
          method: `${transport.sessionId}:permission`,
          request: {
            id: reqId,
            approved,
            ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
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

    sessionList: async ({ limit, cursor, activeOnly, archivedOnly, includeSystem, resumableOnly }) => {
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
