import { readBackendTargetRefV2, type ActionExecutorDeps } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { buildAgentBackendInventoryItems } from '@/session/actions/inventory/buildAgentBackendInventoryItems';
import { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import {
  normalizeLimit,
  readSessionMetadata,
  readSessionModelsState,
  readSessionModesState,
} from './sessionStateReaders';

export function createCliActionInventoryDeps(params: Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  ctx: SessionEncryptionContext;
  mode?: SessionStoredContentEncryptionMode;
  rawSession?: Readonly<{ metadata?: unknown }> | null;
  happyHomeDir?: string;
}>): Pick<ActionExecutorDeps, 'reviewEnginesList' | 'agentsBackendsList' | 'agentsModelsList' | 'sessionModesList'> {
  const metadataCache = new Map<string, Record<string, unknown> | null>();
  let accountSettingsPromise: Promise<import('@happier-dev/protocol').AccountSettings | null> | null = null;
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

  const readAccountSettings = async (): Promise<import('@happier-dev/protocol').AccountSettings | null> => {
    if (!accountSettingsPromise) {
      accountSettingsPromise = resolveAvailableAccountSettings({
        credentials: params.credentials ?? null,
      });
    }
    return await accountSettingsPromise;
  };

  return {
    reviewEnginesList: async ({ sessionId, includeDisabled }) => ({
      sessionId,
      items: buildReviewEngineInventoryItems({
        includeDisabled,
        accountSettings: await readAccountSettings(),
      }),
    }),
    agentsBackendsList: async (args) => ({
      items: await buildAgentBackendInventoryItems({
        limit: (args as { limit?: unknown }).limit,
        includeDisabled: (args as { includeDisabled?: boolean }).includeDisabled === true,
        accountSettings: await readAccountSettings(),
        happyHomeDir: params.happyHomeDir,
      }),
    }),
    agentsModelsList: async (args) => {
      const agentId = args.agentId;
      const backendTargetKey = typeof (args as { backendTargetKey?: unknown }).backendTargetKey === 'string'
        ? (args as { backendTargetKey?: string }).backendTargetKey?.trim() ?? ''
        : '';
      const limit = (args as { limit?: unknown }).limit;
      const normalizedAgentId = String(agentId ?? '').trim();
      const backendTarget = backendTargetKey
        ? (() => {
            try {
              return readBackendTargetRefV2(backendTargetKey);
            } catch {
              return null;
            }
          })()
        : null;
      const usesConfiguredCompatBackend = backendTarget?.sourceKind === 'configured' || Boolean(backendTarget?.configuredBackendId);
      const modelState = readSessionModelsState(await readSessionMetadataForId(params.sessionId));
      const provider = typeof modelState?.provider === 'string' ? modelState.provider.trim() : '';
      const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
      const shouldUseSessionMetadataModels = Boolean(
        provider && (
          (normalizedAgentId && provider === normalizedAgentId)
          || (usesConfiguredCompatBackend && (provider === 'customAcp' || provider.startsWith('acp:')))
        ),
      );
      const items = !shouldUseSessionMetadataModels
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
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        items: bounded ? dedupedItems.slice(0, bounded) : dedupedItems,
        supportsFreeform: false,
        source: shouldUseSessionMetadataModels ? 'session_metadata' : 'static',
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
