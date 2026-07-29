import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol';

import {
  createSessionFixture,
  installVoiceWebRtcBrowserBoundary,
} from '@/dev/testkit';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { upsertAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  buildVoiceTranscriptHistorySessionMetadata,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import {
  VOICE_WEBRTC_LIMITS,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import {
  voiceConversationRuntimeMachine,
} from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceHistoryConsumer } from '@/voice/history/voiceHistoryConsumer';
import { canDeleteVoiceHistorySession } from '@/voice/history/defaultVoiceHistoryConsumer';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  createExternalVoiceProviderActivationScope,
} from './externalVoiceProviderActivation';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';

function openAiEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES
    .find((candidate) => candidate.uiEntry.providerId === 'realtime_openai');
  if (!entry) throw new Error('realtime_openai bundled entry missing');
  return entry;
}

const OPENAI_HISTORY_SESSION_ID = 'voice-history-openai-composed';
const OPENAI_SOURCE_CREDENTIAL = 'sk_source_composed';

function installOpenAiSettings(): void {
  const entry = openAiEntry();
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: entry.uiEntry.pluginId,
    declaration: entry.uiEntry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
  const voice = voiceSettingsParse({
    providerId: 'realtime_openai',
    providers: {
      realtime_openai: {
        schemaVersion: 1,
        config: {
          authentication: { source: 'voice_saved_secret' },
          model: { kind: 'pinned', id: 'gpt-realtime' },
          voice: 'marin',
          instructions: null,
          turnDetection: 'server_vad',
          inputTranscriptionModel: null,
        },
      },
    },
  });
  const credentialSettings = upsertAccountVoiceCredential({
    settings: settingsParse({
      ...settingsDefaults,
      voiceSettingsV1: voice,
    }),
    providerId: 'realtime_openai',
    credentialSlotId: recipientContract.credentialSlot.id,
    value: OPENAI_SOURCE_CREDENTIAL,
    generateId: () => 'realtime-openai-composed-secret',
    now: 1,
    expectedSecretId: null,
    expectedSecretUpdatedAt: null,
    approvedRecipientContractDigest:
      createRecipientContractDigestV1(recipientContract),
  }).settings;
  storage.setState((current) => ({
    ...current,
    settings: {
      ...credentialSettings,
      voice: {
        ...voice,
        credentialBindings: credentialSettings.voice.credentialBindings,
      },
    },
    sessions: {
      [OPENAI_HISTORY_SESSION_ID]: createSessionFixture({
        id: OPENAI_HISTORY_SESSION_ID,
        active: false,
        encryptionMode: 'plain',
        metadata: {
          path: '/voice-transcript-history',
          host: 'happier.test',
          ...buildVoiceTranscriptHistorySessionMetadata(),
        },
      }),
    },
    sessionMessages: {},
  }) as never);
}

function installOpenAiFetchBoundary(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/realtime/client_secrets')) {
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${OPENAI_SOURCE_CREDENTIAL}`);
      return new Response(JSON.stringify({
        value: 'ek_source_composed',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/realtime/calls')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ek_source_composed',
      });
      return new Response('v=0\r\na=openai-answer\r\n', { status: 201 });
    }
    throw new Error(`unexpected OpenAI fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function setBufferedAmount(
  channel: EventTarget,
  bufferedAmount: number,
): void {
  Object.defineProperties(channel, {
    bufferedAmount: {
      configurable: true,
      writable: true,
      value: bufferedAmount,
    },
    bufferedAmountLowThreshold: {
      configurable: true,
      writable: true,
      value: 0,
    },
  });
}

function openAiSessionUpdates(sent: readonly string[]): readonly unknown[] {
  return sent
    .map((value) => JSON.parse(value) as unknown)
    .filter((value) => (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Readonly<{ type?: unknown }>).type === 'session.update'
    ));
}

function createSourceComposedOpenAiRuntime(
  browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>,
) {
  const hostLease = createBundledConversationRuntimeHostLease();
  const controlSessionId = hostLease.host.globalVoiceSessionId;
  const host = Object.freeze({
    ...hostLease.host,
    getPlatform: () => 'web' as const,
    createMicSession: () => browser.micSession,
    acquireAudioMode: async () => Object.freeze({
      release: async () => undefined,
    }),
  });
  const entry = openAiEntry();
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: entry.uiEntry.pluginId,
    declaration: entry.uiEntry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
  voiceSessionBindingStore.getState().bind({
    adapterId: entry.uiEntry.providerId,
    controlSessionId,
    conversationSessionId: OPENAI_HISTORY_SESSION_ID,
    lifetime: 'runtime_attempt',
    transcriptMode: 'synthetic',
    targetSessionId: null,
    updatedAt: 1,
  });
  const requestAccountOperation = vi.fn();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: entry.uiEntry.pluginId,
    declarations: [entry.uiEntry.declaration],
    hostPlatform: 'web',
    runtimeHost: host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === hostLease.host,
    hostBindingsByLocalId: Object.freeze({
      [entry.uiEntry.declaration.id]: Object.freeze({
        providerId: entry.uiEntry.providerId,
        recipientContract,
        createInvocationAccountOperations: (
          signal: AbortSignal,
          _conversationSessionId: string | null,
          isCurrent: () => boolean,
        ) => {
          const accountOperations = createAccountVoiceOperationService({
            providerId: entry.uiEntry.providerId,
            recipientContract,
            signal,
            isCurrent,
            requireRecipientApproval: true,
          });
          requestAccountOperation.mockImplementation(accountOperations.request);
          return Object.freeze({ request: requestAccountOperation });
        },
        descriptor: 'bundled' as const,
        resolveSurfaceCapabilities: (settings: unknown) => {
          const projection = host.projectVoiceSettings(
            settings,
            entry.uiEntry.providerId,
          );
          if (projection?.providerId !== entry.uiEntry.providerId) return null;
          return entry.uiEntry.internal.resolveSurfaceCapabilities?.(
            projection.providerConfig,
          ) ?? null;
        },
      }),
    }),
  });
  entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
  const commit = scope.commit();
  if (commit) void commit.catch(() => undefined);
  const registration = getExternalVoiceProviderRegistration(
    entry.uiEntry.providerId,
  );
  if (!registration?.adapter) {
    throw new Error('realtime_openai bundled activation failed');
  }
  const runtime = Object.freeze({
    adapter: registration.adapter,
    async dispose() {
      await scope.unwind();
    },
  });
  registerVoiceAdapters([runtime.adapter]);
  return Object.freeze({
    controlSessionId,
    hostLease,
    requestAccountOperation,
    runtime,
  });
}

describe('realtime_openai source-composed WebRTC gate', () => {
  beforeEach(() => {
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    installOpenAiSettings();
    installOpenAiFetchBoundary();
    let nextTranscriptSeq = 0;
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
      expect(path).toBe(
        `/v2/sessions/${OPENAI_HISTORY_SESSION_ID}/messages`,
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    voiceConversationRuntimeMachine.reset();
  });

  it('runs approved SavedSecret through public activation and reuses the canonical no-daemon history carrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      expect(composed.requestAccountOperation).toHaveBeenCalledTimes(1);
      expect(Object.keys(storage.getState().sessions)).toEqual([
        OPENAI_HISTORY_SESSION_ID,
      ]);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).toMatchObject({
        adapterId: 'realtime_openai',
        controlSessionId: composed.controlSessionId,
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'synthetic',
      });
      expect(binding?.conversationSessionId).toBe(OPENAI_HISTORY_SESSION_ID);
      expect(storage.getState().sessions[binding!.conversationSessionId]).toMatchObject({
        id: OPENAI_HISTORY_SESSION_ID,
        active: false,
      });
      await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
        openConversationSessionId: binding!.conversationSessionId,
        fallbackControlSessionId: composed.controlSessionId,
        activeAdapterId: 'realtime_openai',
        providerId: 'realtime_openai',
        requestedTargetSessionId: null,
      })).resolves.toEqual({ conversationSessionId: null });

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-user-final',
        item_id: 'saved-secret-user',
        content_index: 0,
        transcript: 'hello without a daemon',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'hello without a daemon',
        }),
      ]));

      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(readCanonicalVoiceTranscriptSnapshot(
        binding!.conversationSessionId,
      )).toEqual([]);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeDefined();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('persists standalone SavedSecret finals through canonical session-message storage', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).not.toBeNull();

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-durable-user-final',
        item_id: 'saved-secret-durable-user',
        content_index: 0,
        transcript: 'persist me without a daemon',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'persist me without a daemon',
        }),
      ]));

      await vi.waitFor(() => {
        const state = storage.getState();
        const storedMessages = Object.keys(state.sessionMessages)
          .flatMap((sessionId) => readStoredSessionMessages(state, sessionId));
        expect(storedMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'user-text',
            text: 'persist me without a daemon',
          }),
        ]));
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('refuses active-carrier clear, persists the next final once, then clears after release', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    let discoveredSessionId: string | null = OPENAI_HISTORY_SESSION_ID;
    const deleteSession = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(discoveredSessionId);
      discoveredSessionId = null;
      return { success: true };
    });
    const consumer = createVoiceHistoryConsumer({
      readScopeKey: () => 'server/account',
      captureScope: async () => ({ key: 'server/account' }),
      discoverHistorySession: async () => discoveredSessionId,
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: (sessionId) =>
        readStoredSessionMessages(storage.getState(), sessionId),
      resolveProviderLabel: () => 'OpenAI Realtime',
      deleteSession,
      canDeleteSession: canDeleteVoiceHistorySession,
      retireLocalSession: (sessionId) =>
        storage.getState().deleteSession(sessionId),
      now: () => new Date('2026-07-29T12:34:56.000Z'),
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      await consumer.open();
      await expect(consumer.clear()).rejects.toMatchObject({
        name: 'VoiceHistoryClearActiveCallError',
        code: 'voice_history_clear_active_call',
      });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )?.conversationSessionId).toBe(OPENAI_HISTORY_SESSION_ID);

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-after-clear-final',
        item_id: 'saved-secret-after-clear',
        content_index: 0,
        transcript: 'persist after clearing history',
        usage: { type: 'duration', seconds: 1 },
      }));

      await vi.waitFor(() => expect(
        readStoredSessionMessages(
          storage.getState(),
          OPENAI_HISTORY_SESSION_ID,
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist after clearing history',
        }),
      ]));

      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();

      await expect(consumer.clear()).resolves.toEqual({ cleared: true });
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeUndefined();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('awaits real session.update send acceptance before publishing connected', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    setBufferedAmount(browser.peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');

      browser.peer.channel.open();
      await vi.waitFor(() => expect(
        (browser.peer.channel as unknown as RTCDataChannel).bufferedAmountLowThreshold,
      ).toBeGreaterThan(0));

      await expect(Promise.race([
        starting.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ])).resolves.toBe('pending');
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');
      expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([]);

      (browser.peer.channel as unknown as { bufferedAmount: number }).bufferedAmount = 0;
      browser.peer.channel.dispatchEvent(new Event('bufferedamountlow'));
      await starting;

      expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([
        expect.objectContaining({ type: 'session.update' }),
      ]);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('closes the peer and never publishes connected when session.update is rejected', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    vi.spyOn(browser.peer.channel, 'send').mockImplementation(() => {
      throw new Error('data channel rejected session.update');
    });
    const composed = createSourceComposedOpenAiRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
      browser.peer.channel.open();

      await expect(starting).rejects.toThrow();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('closes the peer and never publishes connected when aborted at the session.update barrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    setBufferedAmount(browser.peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    const composed = createSourceComposedOpenAiRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
      browser.peer.channel.open();
      await vi.waitFor(() => expect(
        (browser.peer.channel as unknown as RTCDataChannel).bufferedAmountLowThreshold,
      ).toBeGreaterThan(0));

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      await starting;

      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });
});
