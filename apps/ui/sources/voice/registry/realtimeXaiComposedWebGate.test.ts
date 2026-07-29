import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol';

import { createSessionFixture } from '@/dev/testkit';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { sync } from '@/sync/sync';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { upsertAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  buildVoiceTranscriptHistorySessionMetadata,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import {
  readVoiceProviderConversationMetadata,
} from '@/voice/persistence/voiceProviderConversationMetadata';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import {
  XAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../packages/plugins/xai/src/protocol/voice/settings';
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

const XAI_HISTORY_SESSION_ID = 'voice-history-xai-composed';
const XAI_SOURCE_CREDENTIAL = 'xai_source_composed';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  emitConversationId(conversationId: string): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'conversation.created',
        conversation: { id: conversationId },
      }),
    });
  }
}

function xaiEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
    (candidate) => candidate.uiEntry.providerId === 'realtime_grok',
  );
  if (!entry) throw new Error('realtime_grok bundled entry missing');
  return entry;
}

function installXaiSettings(resumptionEnabled: boolean): void {
  const entry = xaiEntry();
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: entry.uiEntry.pluginId,
    declaration: entry.uiEntry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_grok recipient contract missing');
  const voice = voiceSettingsParse({
    providerId: 'realtime_grok',
    providers: {
      realtime_grok: {
        schemaVersion: 1,
        config: {
          ...XAI_REALTIME_DEFAULT_SETTINGS,
          resumptionEnabled,
        },
      },
    },
  });
  const credentialSettings = upsertAccountVoiceCredential({
    settings: settingsParse({
      ...settingsDefaults,
      voiceSettingsV1: voice,
    }),
    providerId: 'realtime_grok',
    credentialSlotId: recipientContract.credentialSlot.id,
    value: XAI_SOURCE_CREDENTIAL,
    generateId: () => 'realtime-xai-composed-secret',
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
      [XAI_HISTORY_SESSION_ID]: createSessionFixture({
        id: XAI_HISTORY_SESSION_ID,
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

function installXaiFetchBoundary(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/v1/realtime/client_secrets')) {
      throw new Error(`unexpected xAI fetch: ${url}`);
    }
    expect(new Headers(init?.headers).get('authorization'))
      .toBe(`Bearer ${XAI_SOURCE_CREDENTIAL}`);
    const body = init?.body instanceof ArrayBuffer
      ? new TextDecoder().decode(new Uint8Array(init.body))
      : String(init?.body);
    expect(JSON.parse(body)).toEqual({
      expires_after: { seconds: 300 },
    });
    return new Response(JSON.stringify({
      value: 'source-composed',
      expires_at: Math.floor(Date.now() / 1_000) + 60,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function createSourceComposedXaiRuntime() {
  const hostLease = createBundledConversationRuntimeHostLease();
  const controlSessionId = hostLease.host.globalVoiceSessionId;
  const ensureMicActive = vi.fn(async () => {});
  const teardownMic = vi.fn(async () => {});
  const pcmStart = vi.fn(async () => {});
  const pcmStop = vi.fn(async () => {});
  const enqueueOutput = vi.fn(() => true);
  const clearOutput = vi.fn();
  const waitForOutputDrain = vi.fn(async () => {});
  const createWebSocketPcmMedia = vi.fn(() => Object.freeze({
    pcm: Object.freeze({
      start: pcmStart,
      stop: pcmStop,
    }),
    enqueueOutput,
    clearOutput,
    waitForOutputDrain,
  }));
  const host = Object.freeze({
    ...hostLease.host,
    getPlatform: () => 'web' as const,
    createMicSession: () => Object.freeze({
      ensureActive: ensureMicActive,
      setMuted: () => {},
      isMuted: () => false,
      teardown: teardownMic,
      getStream: () => null,
    }),
    createWebSocketPcmMedia,
    acquireAudioMode: async () => Object.freeze({
      release: async () => undefined,
    }),
  });
  const entry = xaiEntry();
  const { uiEntry } = entry;
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: uiEntry.pluginId,
    declaration: uiEntry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_grok recipient contract missing');
  voiceSessionBindingStore.getState().bind({
    adapterId: uiEntry.providerId,
    controlSessionId,
    conversationSessionId: XAI_HISTORY_SESSION_ID,
    lifetime: 'runtime_attempt',
    transcriptMode: 'synthetic',
    targetSessionId: null,
    updatedAt: 1,
  });
  const requestAccountOperation = vi.fn();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: uiEntry.pluginId,
    declarations: [uiEntry.declaration],
    hostPlatform: 'web',
    runtimeHost: host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === hostLease.host,
    hostBindingsByLocalId: Object.freeze({
      [uiEntry.declaration.id]: Object.freeze({
        providerId: uiEntry.providerId,
        recipientContract: createBundledVoiceRecipientContract({
          pluginId: uiEntry.pluginId,
          declaration: uiEntry.declaration,
        }),
        createInvocationAccountOperations: (
          signal: AbortSignal,
          _conversationSessionId: string | null,
          isCurrent: () => boolean,
        ) => {
          const accountOperations = createAccountVoiceOperationService({
            providerId: uiEntry.providerId,
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
          const projection = host.projectVoiceSettings(settings, uiEntry.providerId);
          if (projection?.providerId !== uiEntry.providerId) return null;
          return uiEntry.internal.resolveSurfaceCapabilities?.(
            projection.providerConfig,
          ) ?? null;
        },
      }),
    }),
  });
  entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
  const commit = scope.commit();
  if (commit) {
    void commit.catch(() => undefined);
  }
  const registration = getExternalVoiceProviderRegistration(uiEntry.providerId);
  if (!registration?.adapter) {
    throw new Error('realtime_grok bundled activation failed');
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
    createWebSocketPcmMedia,
    ensureMicActive,
    hostLease,
    pcmStart,
    pcmStop,
    requestAccountOperation,
    runtime,
    teardownMic,
  });
}

describe('realtime_grok source-composed direct-media persistence gate', () => {
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
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    installXaiFetchBoundary();
    let nextTranscriptSeq = 0;
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
      expect(path).toBe(
        `/v2/sessions/${XAI_HISTORY_SESSION_ID}/messages`,
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `xai-history-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(sync, 'patchSessionMetadataWithRetry').mockImplementation(
      async (sessionId, updater) => {
        const session = storage.getState().sessions[sessionId];
        if (!session) throw new Error(`missing session ${sessionId}`);
        if (!session.metadata) throw new Error(`missing session metadata ${sessionId}`);
        const metadata = updater(session.metadata);
        storage.setState((current) => ({
          ...current,
          sessions: {
            ...current.sessions,
            [sessionId]: {
              ...session,
              metadata,
            },
          },
        }) as never);
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    voiceConversationRuntimeMachine.reset();
  });

  it('runs approved SavedSecret through public activation, host PCM/WebSocket, and the canonical history carrier', async () => {
    installXaiSettings(false);
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = createSourceComposedXaiRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', initialContext: '' });

      expect(composed.requestAccountOperation).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.protocols).toEqual([
        'xai-client-secret.source-composed',
      ]);
      expect(composed.ensureMicActive).toHaveBeenCalledTimes(1);
      expect(composed.createWebSocketPcmMedia).toHaveBeenCalledTimes(1);
      expect(composed.pcmStart).toHaveBeenCalledTimes(1);
      expect(Object.keys(storage.getState().sessions)).toEqual([
        XAI_HISTORY_SESSION_ID,
      ]);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).toMatchObject({
        adapterId: 'realtime_grok',
        lifetime: 'runtime_attempt',
        targetSessionId: null,
      });
      expect(binding?.conversationSessionId).toBe(XAI_HISTORY_SESSION_ID);
      expect(storage.getState().sessions[binding!.conversationSessionId]).toMatchObject({
        id: XAI_HISTORY_SESSION_ID,
        active: false,
      });
      await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
        openConversationSessionId: binding!.conversationSessionId,
        fallbackControlSessionId: composed.controlSessionId,
        activeAdapterId: 'realtime_grok',
        providerId: 'realtime_grok',
        requestedTargetSessionId: null,
      })).resolves.toEqual({ conversationSessionId: null });

      FakeWebSocket.instances[0]!.emitConversationId('conv-runtime-only');
      await Promise.resolve();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(patchSessionMetadata).not.toHaveBeenCalled();

      FakeWebSocket.instances[0]!.emit('message', {
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 'xai-source-composed-user-final',
          item_id: 'xai-source-composed-user',
          transcript: 'hello through Grok Voice',
        }),
      });
      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'hello through Grok Voice',
        }),
      ]));
      await vi.waitFor(() => {
        const state = storage.getState();
        const storedMessages = Object.keys(state.sessionMessages)
          .flatMap((sessionId) => readStoredSessionMessages(state, sessionId));
        expect(storedMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'user-text',
            text: 'hello through Grok Voice',
          }),
        ]));
      });

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(composed.pcmStop).toHaveBeenCalledTimes(1);
      expect(composed.teardownMic).toHaveBeenCalledTimes(1);
      expect(readCanonicalVoiceTranscriptSnapshot(
        binding!.conversationSessionId,
      )).toEqual([]);
      expect(storage.getState().sessions[binding!.conversationSessionId])
        .toBeDefined();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('persists and resumes the provider conversation on the durable history carrier', async () => {
    installXaiSettings(true);
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = createSourceComposedXaiRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', initialContext: '' });

      expect(composed.requestAccountOperation).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(1);
      FakeWebSocket.instances[0]!.emitConversationId('conv-durable');
      await vi.waitFor(() => expect(patchSessionMetadata).toHaveBeenCalledTimes(1));
      expect(readVoiceProviderConversationMetadata(
        storage.getState().sessions[XAI_HISTORY_SESSION_ID]?.metadata,
        'realtime_grok',
      )).toMatchObject({
        conversationId: 'conv-durable',
      });

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      voiceSessionBindingStore.getState().bind({
        adapterId: 'realtime_grok',
        controlSessionId: composed.controlSessionId,
        conversationSessionId: XAI_HISTORY_SESSION_ID,
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionId: null,
        updatedAt: 2,
      });
      await composed.runtime.adapter.start({ sessionId: '', initialContext: '' });

      expect(composed.requestAccountOperation).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(new URL(FakeWebSocket.instances[1]!.url).searchParams.get(
        'conversation_id',
      )).toBe('conv-durable');
      expect(composed.hostLease.host.canPersistProviderConversationState?.({
        providerId: 'realtime_openai',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
      })).toBe(false);

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(composed.hostLease.host.canPersistProviderConversationState?.({
        providerId: 'realtime_grok',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
      })).toBe(false);
      const writeProviderConversationState =
        composed.hostLease.host.writeProviderConversationState;
      if (!writeProviderConversationState) {
        throw new Error('provider conversation persistence host missing');
      }
      await expect(writeProviderConversationState({
        providerId: 'realtime_grok',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
        state: { conversationId: 'stale-after-stop' },
      })).rejects.toThrow('voice_provider_conversation_persistence_unavailable');
      expect(readVoiceProviderConversationMetadata(
        storage.getState().sessions[XAI_HISTORY_SESSION_ID]?.metadata,
        'realtime_grok',
      )).toMatchObject({
        conversationId: 'conv-durable',
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });
});
