import {
  buildBackendTargetKey,
  getActionSpec,
  listNativeReviewEngines,
  type ActionExecutorDeps,
  type ActionId,
} from '@happier-dev/protocol';
import {
  AGENT_IDS,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  getProviderCliRuntimeSpec,
  readMetadataAliasValue,
  type AgentId,
} from '@happier-dev/agents';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';

import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  decryptStoredSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  executeExecutionRunAction,
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
} from '@/session/services/executionRuns';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

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
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{ metadata?: unknown }> | null;
}>): Pick<ActionExecutorDeps, 'reviewEnginesList' | 'agentsBackendsList' | 'agentsModelsList' | 'sessionModesList'> {
  let currentSessionMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });

  const readCurrentSessionMetadata = async (sessionId: string): Promise<Record<string, unknown> | null> => {
    if (sessionId !== params.sessionId) return null;
    if (currentSessionMetadata) return currentSessionMetadata;

    try {
      const rawSession = await fetchSessionById({ token: params.token, sessionId });
      currentSessionMetadata = readSessionMetadata({
        rawSession,
        mode: params.mode,
        ctx: params.ctx,
      });
    } catch {
      currentSessionMetadata = null;
    }

    return currentSessionMetadata;
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
      const modelState = readSessionModelsState(await readCurrentSessionMetadata(params.sessionId));
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
      const sessionModes = readSessionModesState(await readCurrentSessionMetadata(sessionId));
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
  let currentSessionMetadata = readSessionMetadata({
    rawSession: params.rawSession,
    mode: params.mode,
    ctx: params.ctx,
  });

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

  return {
    executionRunStart: async (_sessionId, request) =>
      await startExecutionRun({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),
    executionRunList: async (_sessionId, request) =>
      await listExecutionRuns({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),
    executionRunGet: async (_sessionId, request) =>
      await getExecutionRun({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),
    executionRunSend: async (_sessionId, request) =>
      await sendExecutionRunMessage({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),
    executionRunStop: async (_sessionId, request) =>
      await stopExecutionRun({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),
    executionRunAction: async (_sessionId, request) =>
      await executeExecutionRunAction({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        request,
      }),

    daemonMemorySearch: async () => notSupported(),
    daemonMemoryGetWindow: async () => notSupported(),
    daemonMemoryEnsureUpToDate: async () => notSupported(),

    sessionOpen: async () => notSupported(),
    sessionFork: async () => notSupported(),
    sessionRollback: async () => notSupported(),
    sessionSpawnNew: async ({ tag, agentId, modelId, path, host, initialMessage }) => {
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

      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      if (normalizedAgentId && !AGENT_IDS.includes(normalizedAgentId as AgentId)) {
        return { type: 'error', errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
      }

      const created = await createSpawnedSession({
        credentials: params.credentials,
        directory,
        ...(currentMachineId ? { machineId: currentMachineId } : {}),
        backendTarget: {
          kind: 'builtInAgent',
          agentId: (normalizedAgentId || DEFAULT_CATALOG_AGENT_ID) as AgentId,
        },
        ...(typeof tag === 'string' && tag.trim().length > 0 ? { tag: tag.trim() } : {}),
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
    ...inventoryDeps,
    sessionSendMessage: async () => notSupported(),
    sessionPermissionRespond: async () => notSupported(),
    sessionUserActionAnswer: async () => notSupported(),
    sessionModeSet: async () => notSupported(),
    sessionTargetPrimarySet: async () => notSupported(),
    sessionTargetTrackedSet: async () => notSupported(),
    sessionList: async () => notSupported(),
    sessionActivityGet: async () => notSupported(),
    sessionRecentMessagesGet: async () => notSupported(),
    resetGlobalVoiceAgent: () => notSupported(),

    isActionEnabled: (actionId: ActionId, ctx) =>
      isActionEnabledByEnv(actionId, {
        surface: ctx?.surface ?? 'cli',
        placement: ctx?.placement ?? null,
      }),
  };
}
