import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { discoverVoiceHistorySession } from '@/voice/history/voiceHistorySessionDiscovery';
import {
  buildVoiceTranscriptHistorySessionMetadata,
  VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@/voice/persistence/voiceTranscriptHistorySession';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

const XAI_ADAPTER_ID = 'happier.voice.xai/realtime-grok';
const OPENAI_ADAPTER_ID = 'happier.voice.openai/realtime-openai';

/**
 * Minimal stand-in for the one genuine boundary this invariant depends on: the
 * server's `(accountId, tag)` unique session table. `POST /v1/sessions` is a
 * get-or-create keyed by that pair
 * (`apps/server/.../registerSessionCreateOrLoadRoute.ts`), and
 * `POST /v2/sessions/lookup-by-tags` filters the same column
 * (`apps/server/.../registerSessionLookupByTagsRoute.ts`). Everything above it —
 * carrier acquisition, binding, identity validation, discovery — is the real
 * implementation.
 */
function createFakeTaggedSessionTable() {
  const sessionIdsByTag = new Map<string, string>();
  let nextSessionId = 0;
  return {
    sessionIdsByTag,
    ensureByTag(tag: string): string {
      const existing = sessionIdsByTag.get(tag);
      if (existing) return existing;
      nextSessionId += 1;
      const sessionId = `srv-session-${nextSessionId}`;
      sessionIdsByTag.set(tag, sessionId);
      return sessionId;
    },
    listByTags(tags: readonly string[]): readonly Readonly<{ id: string }>[] {
      return tags
        .map((tag) => sessionIdsByTag.get(tag))
        .filter((id): id is string => Boolean(id))
        .map((id) => Object.freeze({ id }));
    },
  };
}

function installCarrierSession(sessionId: string): void {
  storage.setState((current) => ({
    ...current,
    sessions: {
      ...current.sessions,
      [sessionId]: createSessionFixture({
        id: sessionId,
        active: false,
        encryptionMode: 'plain',
        metadata: {
          path: '/voice-transcript-history',
          host: 'happier.test',
          ...buildVoiceTranscriptHistorySessionMetadata(),
        } as never,
      }),
    },
  }) as never);
}

describe('voice history carrier single ownership', () => {
  let table: ReturnType<typeof createFakeTaggedSessionTable>;

  beforeEach(() => {
    table = createFakeTaggedSessionTable();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    storage.setState((current) => ({
      ...current,
      sessions: {},
      sessionMessages: {},
    }) as never);
    vi.spyOn(sync, 'ensureHostedSystemSession').mockImplementation(async (input) => {
      const sessionId = table.ensureByTag(input.tag);
      installCarrierSession(sessionId);
      return { sessionId };
    });
    vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute').mockImplementation(
      async (sessionId) => {
        if (table.sessionIdsByTag.get(VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG) === sessionId) {
          installCarrierSession(sessionId);
        }
        return { kind: 'available', sessionId } as never;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives every targetless provider attempt in one account the carrier Voice History reads', async () => {
    const lease = createBundledConversationRuntimeHostLease();
    try {
      const xai = await lease.host.acquireDirectMediaConversation({
        adapterId: XAI_ADAPTER_ID,
        controlSessionId: lease.host.globalVoiceSessionId,
        requestedTargetSessionId: null,
      });
      const openai = await lease.host.acquireDirectMediaConversation({
        adapterId: OPENAI_ADAPTER_ID,
        controlSessionId: lease.host.globalVoiceSessionId,
        requestedTargetSessionId: null,
      });

      expect(openai.conversationSessionId).toBe(xai.conversationSessionId);
      expect(
        lease.host.resolveConversationSessionId(
          lease.host.globalVoiceSessionId,
          OPENAI_ADAPTER_ID,
        ),
      ).toBe(xai.conversationSessionId);

      const historyReaderSessionId = await discoverVoiceHistorySession({
        prepareLookup: async () => {},
        lookupByTags: async (tags) => table.listByTags(tags),
        hydrateSession: (sessionId) => sync.ensureSessionVisibleForMessageRoute(sessionId, {
          forceRefresh: true,
        }) as never,
        readHydratedSession: (sessionId) =>
          storage.getState().sessions[sessionId] ?? null,
      });
      expect(historyReaderSessionId).toBe(xai.conversationSessionId);
    } finally {
      lease.revoke();
    }
  });
});
