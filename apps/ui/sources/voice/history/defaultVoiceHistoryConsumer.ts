import { SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sessionDeleteWithServerAccountAuthority } from '@/sync/ops/sessions';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
  captureSessionRequestAuthorityForServerAccountScope,
  type ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { t, tLoose } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import {
  createVoiceHistoryConsumer,
  type VoiceHistoryCapturedScope,
  type VoiceHistoryPageResult,
  type VoiceHistoryProviderSource,
} from './voiceHistoryConsumer';
import { discoverVoiceHistorySession } from './voiceHistorySessionDiscovery';

function findVoiceHistoryProviderEntry(
  registry: VoiceProviderRegistry,
  source: VoiceHistoryProviderSource | null,
): ReturnType<VoiceProviderRegistry['get']> {
  if (!source) return null;
  return registry.list().find((candidate) => (
    candidate.kind === 'voice.conversation-provider.v1'
    && candidate.pluginId === source.pluginId
    && (
      candidate.declaration?.id === source.contributionId
      || candidate.providerId === source.contributionId
      || (
        candidate.source.kind === 'external'
        && candidate.source.pluginId === source.pluginId
        && candidate.source.localId === source.contributionId
      )
    )
  )) ?? null;
}

export function resolveVoiceHistoryProviderLabel(
  registry: VoiceProviderRegistry,
  source: VoiceHistoryProviderSource | null,
  translateTitleKey: (key: string) => string,
): string | null {
  const entry = findVoiceHistoryProviderEntry(registry, source);
  if (!entry) return null;
  if (entry.kind === 'voice.conversation-provider.v1') {
    const rawTitle = entry.declaration?.title;
    const descriptorTitle = (
      typeof rawTitle === 'string' ? rawTitle : rawTitle?.fallback
    )?.trim();
    if (descriptorTitle) return descriptorTitle;
  }
  const titleKey = entry.selectionOptions?.[0]?.titleKey;
  return titleKey ? translateTitleKey(titleKey) : entry.providerId;
}

type DefaultVoiceHistoryCapturedScope = VoiceHistoryCapturedScope & Readonly<{
  authority: ServerAccountSessionRequestAuthority;
}>;

export type DefaultVoiceHistoryRuntime = Readonly<{
  readActiveScope(): ServerAccountScope | null;
  captureAuthority(scope: ServerAccountScope): Promise<ServerAccountSessionRequestAuthority>;
  lookupByTags(
    tags: readonly string[],
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<readonly { id: string }[]>;
  hydrateSession(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<Readonly<{ kind: string; sessionId?: string }>>;
  readHydratedSession(sessionId: string): Session | null;
  refreshSessionMessages(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<void>;
  loadOlderMessages(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<VoiceHistoryPageResult>;
  readMessages(sessionId: string): ReturnType<typeof readStoredSessionMessages>;
  deleteSession(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<Readonly<{ success: boolean; message?: string }>>;
  retireLocalSession(sessionId: string): void;
}>;

export function createDefaultVoiceHistoryConsumerFromRuntime(
  runtime: DefaultVoiceHistoryRuntime,
  providerRegistry: VoiceProviderRegistry,
) {
  return createVoiceHistoryConsumer({
    readScopeKey: () => {
      const scope = runtime.readActiveScope();
      return scope ? serverAccountScopeKeySuffix(scope) : null;
    },
    captureScope: async (): Promise<DefaultVoiceHistoryCapturedScope | null> => {
      const scope = runtime.readActiveScope();
      if (!scope) return null;
      const authority = await runtime.captureAuthority(scope);
      return {
        key: serverAccountScopeKeySuffix(scope),
        authority,
      };
    },
    discoverHistorySession: (scope) => discoverVoiceHistorySession({
      lookupByTags: (tags) => runtime.lookupByTags(tags, scope.authority),
      hydrateSession: (sessionId) => runtime.hydrateSession(sessionId, scope.authority),
      readHydratedSession: runtime.readHydratedSession,
    }),
    refreshSessionMessages: (sessionId, scope) =>
      runtime.refreshSessionMessages(sessionId, scope.authority),
    loadOlderMessages: (sessionId, scope) =>
      runtime.loadOlderMessages(sessionId, scope.authority),
    readMessages: runtime.readMessages,
    resolveProviderLabel: (source) => {
      return resolveVoiceHistoryProviderLabel(providerRegistry, source, tLoose)
        ?? source?.contributionId
        ?? t('voiceAssistant.label');
    },
    deleteSession: (sessionId, scope) =>
      runtime.deleteSession(sessionId, scope.authority),
    retireLocalSession: runtime.retireLocalSession,
    now: () => new Date(),
  });
}

export function createDefaultVoiceHistoryConsumer() {
  const sync = getSyncSingleton();
  const providerRegistry = createDefaultVoiceProviderRegistry();
  const runtime: DefaultVoiceHistoryRuntime = {
    readActiveScope: getActiveServerAccountScope,
    captureAuthority: (scope) =>
      captureSessionRequestAuthorityForServerAccountScope({
        scope,
        activeRequest: (path, init) => apiSocket.request(path, init),
      }),
    lookupByTags: async (tags, authority) => {
      const response = await authority.request('/v2/sessions/lookup-by-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!response.ok) {
        throw new Error(`Voice History lookup failed (${response.status})`);
      }
      const parsed = SessionLookupByTagsResponseV2Schema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error('Voice History lookup returned an invalid response');
      }
      return parsed.data.sessions;
    },
    hydrateSession: (sessionId, authority) =>
      sync.ensureSessionVisibleForMessageRoute(sessionId, {
        forceRefresh: true,
        authority,
      }),
    readHydratedSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
    refreshSessionMessages: (sessionId, authority) =>
      sync.refreshSessionMessages(sessionId, { authority }),
    loadOlderMessages: (sessionId, authority) =>
      sync.loadOlderMessages(sessionId, { authority }),
    readMessages: (sessionId) =>
      readStoredSessionMessages(storage.getState(), sessionId),
    deleteSession: sessionDeleteWithServerAccountAuthority,
    retireLocalSession: (sessionId) => storage.getState().deleteSession(sessionId),
  };
  return createDefaultVoiceHistoryConsumerFromRuntime(runtime, providerRegistry);
}
