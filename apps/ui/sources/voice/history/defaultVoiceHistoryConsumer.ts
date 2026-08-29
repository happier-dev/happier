import { SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
  isAccountStoredContentClientUpgradeRequiredError,
  requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  sessionDeleteWithServerAccountAuthority,
  type SessionDeleteResult,
} from '@/sync/ops/sessions';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
  captureSessionRequestAuthorityForServerAccountScope,
  type ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { t, tLoose } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
  runVoiceTranscriptHistoryCarrierOperation,
} from '@/voice/persistence/voiceTranscriptHistorySession';

import {
  createVoiceHistoryConsumer,
  type VoiceHistoryCapturedScope,
  type VoiceHistoryPageResult,
  type VoiceHistoryProviderSource,
  isVoiceHistoryOperationSupersededError,
} from './voiceHistoryConsumer';
import { discoverVoiceHistorySession } from './voiceHistorySessionDiscovery';

type VoiceHistoryLoadStage =
  | 'capture_scope'
  | 'compatibility'
  | 'lookup'
  | 'hydrate'
  | 'refresh';

class VoiceHistoryLoadError extends Error {
  readonly code = 'voice_history_load_failed';

  constructor(
    readonly stage: VoiceHistoryLoadStage,
    status?: number,
  ) {
    super('Voice History failed to load');
    this.name = 'VoiceHistoryLoadError';
    const normalizedStatus = normalizeVoiceHistoryHttpStatus(status);
    if (normalizedStatus !== undefined) {
      Object.defineProperty(this, 'status', {
        value: normalizedStatus,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}

function normalizeVoiceHistoryHttpStatus(status: unknown): number | undefined {
  return typeof status === 'number'
    && Number.isInteger(status)
    && status >= 100
    && status <= 599
    ? status
    : undefined;
}

function readBoundedVoiceHistoryHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return normalizeVoiceHistoryHttpStatus(
    Object.getOwnPropertyDescriptor(error, 'status')?.value,
  );
}

function rethrowVoiceHistoryLoadFailure(
  stage: VoiceHistoryLoadStage,
  error: unknown,
): never {
  if (
    error instanceof VoiceHistoryLoadError
    || isVoiceHistoryOperationSupersededError(error)
    || isAccountStoredContentClientUpgradeRequiredError(error)
  ) {
    throw error;
  }
  throw new VoiceHistoryLoadError(
    stage,
    stage === 'lookup' ? readBoundedVoiceHistoryHttpStatus(error) : undefined,
  );
}

async function runVoiceHistoryLoadStage<T>(
  stage: VoiceHistoryLoadStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return rethrowVoiceHistoryLoadFailure(stage, error);
  }
}

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
  prepareSessionLookup(authority: ServerAccountSessionRequestAuthority): Promise<void>;
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
  readMessages(sessionId: string): readonly Message[];
  readMessagesRevision(sessionId: string): number;
  subscribeMessages(listener: () => void): () => void;
  /**
   * The canonical scoped client result, not a narrowed copy of it: the typed
   * `session_absent` / `session_delete_conflict` outcome is what decides whether
   * History retires its decrypted rows, so this seam must not erase it.
   */
  deleteSession(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
  ): Promise<SessionDeleteResult>;
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
    captureScope: () => runVoiceHistoryLoadStage(
      'capture_scope',
      async (): Promise<DefaultVoiceHistoryCapturedScope | null> => {
        const scope = runtime.readActiveScope();
        if (!scope) return null;
        const authority = await runtime.captureAuthority(scope);
        return {
          key: serverAccountScopeKeySuffix(scope),
          authority,
        };
      },
    ),
    discoverHistorySession: (scope) => discoverVoiceHistorySession({
      prepareLookup: () => runVoiceHistoryLoadStage(
        'compatibility',
        () => runtime.prepareSessionLookup(scope.authority),
      ),
      lookupByTags: (tags) => runVoiceHistoryLoadStage(
        'lookup',
        () => runtime.lookupByTags(tags, scope.authority),
      ),
      hydrateSession: (sessionId) => runVoiceHistoryLoadStage(
        'hydrate',
        () => runtime.hydrateSession(sessionId, scope.authority),
      ),
      readHydratedSession: (sessionId) => {
        try {
          return runtime.readHydratedSession(sessionId);
        } catch (error) {
          return rethrowVoiceHistoryLoadFailure('hydrate', error);
        }
      },
    }),
    refreshSessionMessages: (sessionId, scope) =>
      runVoiceHistoryLoadStage(
        'refresh',
        () => runtime.refreshSessionMessages(sessionId, scope.authority),
      ),
    loadOlderMessages: (sessionId, scope) =>
      runtime.loadOlderMessages(sessionId, scope.authority),
    readMessages: runtime.readMessages,
    readMessagesRevision: runtime.readMessagesRevision,
    readProjectionRevision: () => providerRegistry.getRevision?.() ?? 0,
    subscribeHistorySources: (listener) => {
      const unsubscribeMessages = runtime.subscribeMessages(listener);
      const unsubscribeRegistry = providerRegistry.subscribe?.(listener);
      return () => {
        unsubscribeMessages();
        unsubscribeRegistry?.();
      };
    },
    resolveProviderLabel: (source) => {
      return resolveVoiceHistoryProviderLabel(providerRegistry, source, tLoose)
        ?? source?.contributionId
        ?? t('voiceAssistant.label');
    },
    deleteSession: (sessionId, scope) =>
      runtime.deleteSession(sessionId, scope.authority),
    retireLocalSession: runtime.retireLocalSession,
    runCarrierOperation: runVoiceTranscriptHistoryCarrierOperation,
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
    prepareSessionLookup: (authority) =>
      requireCurrentAccountStoredContentServerCompatibility({
        serverId: authority.scope.serverId,
      }),
    lookupByTags: async (tags, authority) => {
      const response = await authority.request('/v2/sessions/lookup-by-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!response.ok) {
        throw new VoiceHistoryLoadError('lookup', response.status);
      }
      const parsed = SessionLookupByTagsResponseV2Schema.safeParse(await response.json());
      if (!parsed.success) {
        throw new VoiceHistoryLoadError('lookup');
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
    // The canonical per-session message revision the transcript hooks already
    // subscribe to. History keys its projection on this instead of the identity
    // of `readStoredSessionMessages`, which materializes a new array per call.
    readMessagesRevision: (sessionId) =>
      storage.getState().sessionMessages[sessionId]?.messagesVersion ?? 0,
    // One store subscription, filtered downstream by the History revision: an
    // unrelated session's write costs a revision comparison and stops there.
    subscribeMessages: (listener) => storage.subscribe(() => { listener(); }),
    deleteSession: sessionDeleteWithServerAccountAuthority,
    retireLocalSession: (sessionId) => sync.retireLocalSession(sessionId),
  };
  return createDefaultVoiceHistoryConsumerFromRuntime(runtime, providerRegistry);
}
