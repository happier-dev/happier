import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSession } from './types';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';

const setAudioModeAsync = vi.fn(async () => {});
vi.mock('expo-audio', () => ({
  AudioModule: {
    setAudioModeAsync,
    requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    getRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  },
}));

const modalAlert = vi.fn();
const modalConfirm = vi.fn(async () => false);
const modalPrompt = vi.fn(async () => null);

const requestMicrophonePermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
const showMicrophonePermissionDeniedAlert = vi.fn();
vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission,
  showMicrophonePermissionDeniedAlert,
}));

const fetchHappierVoiceToken = vi.fn();
const completeHappierVoiceSession = vi.fn(async () => {});
vi.mock('@/sync/api/voice/apiVoice', () => ({
  fetchHappierVoiceToken,
  completeHappierVoiceSession,
}));
const fetchElevenLabsConversationTokenByo = vi.fn();
const fetchElevenLabsConversationSignedUrlByo = vi.fn();
const appendVoiceConversationNoteText = vi.fn();
const resolveVoiceSessionBindingByControlSessionId = vi.fn((_params: any) => ({
  conversationSessionId: 'voice-conversation-1',
}));
vi.mock('./elevenLabsByo', () => ({
  fetchElevenLabsConversationTokenByo,
  fetchElevenLabsConversationSignedUrlByo,
}));
const ensureVoiceBinding = vi.fn(async (_params: any) => null);
const syncVoiceBindingTarget = vi.fn(async (_params: any) => {});

const getCredentials = vi.fn(async () => ({ token: 't', secret: 's' }));
vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: {
    getCredentials,
    invalidateCredentialsTokenForServerUrl: vi.fn(async () => {}),
  },
  isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({
    serverId: 'server-test',
    serverUrl: 'http://localhost:9999',
    kind: 'stack',
    generation: 1,
  }),
}));

const presentPaywall = vi.fn(async () => ({ success: true, purchased: true }));
vi.mock('@/sync/sync', () => ({
  sync: {
    presentPaywall,
    decryptSecretValue: (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      const maybeValue = (value as { value?: unknown }).value;
      return typeof maybeValue === 'string' ? maybeValue : null;
    },
  },
}));

type TestSettings = {
  experiments: boolean;
  voice: {
    providerId: string;
    adapters: {
      realtime_elevenlabs: {
        assistantLanguage: string | null;
        billingMode: 'happier' | 'byo';
        welcome?: {
          enabled: boolean;
          mode: 'immediate' | 'on_first_turn';
          templateId: string | null;
        };
        byo: {
          agentId: string | null;
          apiKey: { value?: string } | null;
        };
      };
    };
  };
};

function makeDefaultSettings(): TestSettings {
  return {
    experiments: false,
    voice: {
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          assistantLanguage: null,
          billingMode: 'happier',
          welcome: { enabled: false, mode: 'immediate', templateId: null },
          byo: { agentId: null, apiKey: null },
        },
      },
    },
  };
}

const state: {
  settings: TestSettings;
  profile: { id: string };
  setRealtimeStatus: ReturnType<typeof vi.fn>;
  setRealtimeMode: ReturnType<typeof vi.fn>;
  clearRealtimeModeDebounce: ReturnType<typeof vi.fn>;
} = {
  settings: makeDefaultSettings(),
  profile: { id: 'u1' },
  setRealtimeStatus: vi.fn(),
  setRealtimeMode: vi.fn(),
  clearRealtimeModeDebounce: vi.fn(),
};

installRealtimeCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlert,
                confirm: modalConfirm,
                prompt: modalPrompt,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => state },
        });
    },
});
vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: any) => resolveVoiceSessionBindingByControlSessionId(params),
}));

function createJsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeVoiceSession(startConversationId: string | null) {
  const startSession = vi.fn(async () => startConversationId);
  const endSession = vi.fn(async () => {});
  const sendTextMessage = vi.fn();
  const sendContextualUpdate = vi.fn();
  const session: VoiceSession = {
    startSession,
    endSession,
    sendTextMessage,
    sendContextualUpdate,
  };
  return { session, startSession, endSession, sendTextMessage, sendContextualUpdate };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('Realtime voice modes', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    state.settings = makeDefaultSettings();
    state.setRealtimeStatus.mockReset();
    state.setRealtimeMode.mockReset();
    state.clearRealtimeModeDebounce.mockReset();
    requestMicrophonePermission.mockResolvedValue({ granted: true, canAskAgain: true });
    installFetchMock();
    fetchHappierVoiceToken.mockReset();
    completeHappierVoiceSession.mockReset();
    fetchElevenLabsConversationTokenByo.mockReset();
    fetchElevenLabsConversationSignedUrlByo.mockReset();
    ensureVoiceBinding.mockReset();
    syncVoiceBindingTarget.mockReset();
    resolveVoiceSessionBindingByControlSessionId.mockReset();
    resolveVoiceSessionBindingByControlSessionId.mockReturnValue({
      conversationSessionId: 'voice-conversation-1',
    });
    vi.doMock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
      voiceSessionBindingManager: {
        ensureBound: (params: any) => ensureVoiceBinding(params),
        syncTargetSession: (params: any) => syncVoiceBindingTarget(params),
      },
    }));
    vi.doMock('@/voice/sessionBinding/voiceConversationTranscript', () => ({
      appendVoiceConversationNoteText: (params: any) => appendVoiceConversationNoteText(params),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('provider selection', () => {
    it('does nothing when voice provider is off', async () => {
      state.settings.voice.providerId = 'off';
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_0');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows an error when BYO is selected but not configured', async () => {
      state.settings.voice.providerId = 'realtime_elevenlabs';
      state.settings.voice.adapters.realtime_elevenlabs.billingMode = 'byo';
      state.settings.voice.adapters.realtime_elevenlabs.byo.agentId = null;
      state.settings.voice.adapters.realtime_elevenlabs.byo.apiKey = null;
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_0');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(modalAlert).toHaveBeenCalledWith('common.error', 'settingsVoice.byo.notConfigured');
    });
  });

  describe('happier voice lifecycle', () => {
    it('records the session limit and announces when the server-minted lease is near expiry', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 40,
      });

      const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
      const { session } = makeVoiceSession('conv_0');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'BASE_CTX');

      expect(appendVoiceConversationNoteText).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationSessionId: 'voice-conversation-1',
          text: 'errors.voiceSessionLimitStarted',
        }),
      );

      await sleep(20);

      expect(appendVoiceConversationNoteText).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationSessionId: 'voice-conversation-1',
          text: 'errors.voiceSessionLimitExpiring',
        }),
      );

      await sleep(50);

      expect(appendVoiceConversationNoteText).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationSessionId: 'voice-conversation-1',
          text: 'errors.voiceSessionLimitExpired',
        }),
      );

      await stopRealtimeSession();
    });

    it('appends welcome instructions to the initial context when enabled (immediate)', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      state.settings.voice.adapters.realtime_elevenlabs.welcome = { enabled: true, mode: 'immediate', templateId: null };

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_0');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'BASE_CTX');

      expect(startSession).toHaveBeenCalledTimes(1);
      // `makeVoiceSession` returns a typed mock; extracting args via `mock.calls` needs casting in this test harness.
      const startArgs = (startSession as any).mock.calls[0]?.[0];
      expect(String(startArgs?.initialContext ?? '')).toContain('BASE_CTX');
      expect(String(startArgs?.initialContext ?? '')).toContain('Start this session with one short friendly greeting');
      expect(String(startArgs?.initialContext ?? '')).not.toContain('ask what we are working on today');
    });

    it('starts Happier Voice via server token minting', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'conv_token' }));
      expect(ensureVoiceBinding).toHaveBeenCalledWith({
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 's1',
        requestedTargetSessionId: 's1',
      });
      expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ shouldPlayInBackground: true }));
    });

    it('starts realtime voice in text-only mode when explicitly requested', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi', false, { textOnly: true });

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ textOnly: true }));
      expect(requestMicrophonePermission).not.toHaveBeenCalled();
    });

    it('uses a signed websocket URL for BYO text-only sessions', async () => {
      state.settings.voice.providerId = 'realtime_elevenlabs';
      state.settings.voice.adapters.realtime_elevenlabs.billingMode = 'byo';
      state.settings.voice.adapters.realtime_elevenlabs.byo.agentId = 'agent_1';
      state.settings.voice.adapters.realtime_elevenlabs.byo.apiKey = { value: 'api_key_1' };
      fetchElevenLabsConversationSignedUrlByo.mockResolvedValueOnce('wss://signed.example');

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi', false, { textOnly: true });

      expect(fetchElevenLabsConversationSignedUrlByo).toHaveBeenCalledWith({
        agentId: 'agent_1',
        apiKey: 'api_key_1',
      });
      expect(fetchElevenLabsConversationTokenByo).not.toHaveBeenCalled();
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        textOnly: true,
        signedUrl: 'wss://signed.example',
      }));
    });

    it('treats the global voice sentinel as a control id and not a target session id', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('__voice_agent__', 'hi', false, { textOnly: true });

      expect(ensureVoiceBinding).toHaveBeenCalledWith({
        adapterId: 'realtime_elevenlabs',
        controlSessionId: '__voice_agent__',
        requestedTargetSessionId: null,
      });
      expect(fetchHappierVoiceToken).toHaveBeenCalledWith(
        { token: 't', secret: 's' },
        expect.objectContaining({ sessionId: null }),
      );
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ textOnly: true }));
    });

    it('does not mark the voice session started when provider returns no conversation id', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession, isVoiceSessionStarted } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession(null);
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'conv_token' }));
      expect(isVoiceSessionStarted()).toBe(false);
      // No active call => best-effort cleanup should revert background audio mode.
      expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ shouldPlayInBackground: false }));
    });

    it('completes usage on stop for Happier Voice sessions', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
      const { session, endSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');
      await stopRealtimeSession();

      expect(endSession).toHaveBeenCalledTimes(1);
      expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ shouldPlayInBackground: false }));
      expect(completeHappierVoiceSession).toHaveBeenCalledWith(
        expect.objectContaining({ token: 't' }),
        { leaseId: 'lease_1', providerConversationId: 'conv_1' },
      );
    });

    it('clears realtime status and speaking mode on stop even when the provider emits no disconnect callback', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
      const { session } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      state.setRealtimeStatus.mockReset();
      state.setRealtimeMode.mockReset();
      state.clearRealtimeModeDebounce.mockReset();

      await stopRealtimeSession();

      expect(state.setRealtimeStatus).toHaveBeenCalledWith('disconnected');
      expect(state.setRealtimeMode).toHaveBeenCalledWith('idle', true);
      expect(state.clearRealtimeModeDebounce).toHaveBeenCalledTimes(1);
    });

    it('retries after paywall purchase without deadlocking', async () => {
      fetchHappierVoiceToken
        .mockResolvedValueOnce({ allowed: false, reason: 'subscription_required' })
        .mockResolvedValueOnce({
          allowed: true,
          token: 'conv_token',
          leaseId: 'lease_1',
          expiresAtMs: Date.now() + 40,
        });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      const startPromise = startRealtimeSession('s1', 'hi');
      const race = Promise.race([
        startPromise.then(() => 'resolved' as const),
        sleep(50).then(() => 'timeout' as const),
      ]);

      expect(await race).toBe('resolved');
      await startPromise;
      expect(presentPaywall).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency and stop behavior', () => {
    it('dedupes concurrent start calls (account-scoped)', async () => {
      fetchHappierVoiceToken.mockResolvedValueOnce({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      const p1 = startRealtimeSession('s1', 'hi');
      const p2 = startRealtimeSession('s2', 'hi');
      await Promise.all([p1, p2]);

      expect(fetchHappierVoiceToken).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(syncVoiceBindingTarget).toHaveBeenCalledWith({
        controlSessionId: 's1',
        targetSessionId: 's2',
      });
    });

    it('does not alert when a start is already in-flight (even with a different session id)', async () => {
      const fetchStarted = createDeferred<void>();
      const neverResolves = createDeferred<import('@/sync/api/voice/apiVoice').VoiceTokenResponse>();
      fetchHappierVoiceToken.mockImplementationOnce(async (_credentials, options) => {
        fetchStarted.resolve();
        const signal = options?.signal;
        if (signal) {
          signal.addEventListener(
            'abort',
            () => neverResolves.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }
        return neverResolves.promise;
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      void startRealtimeSession('s1', 'hi');
      await fetchStarted.promise;
      const p2 = startRealtimeSession('s2', 'hi');

      expect(fetchHappierVoiceToken).toHaveBeenCalledTimes(1);
      expect(startSession).not.toHaveBeenCalled();
      expect(modalAlert).not.toHaveBeenCalled();

      // Unblock in-flight work so test can finish cleanly.
      neverResolves.resolve({
        allowed: true,
        token: 'conv_token',
        leaseId: 'lease_1',
        expiresAtMs: Date.now() + 60_000,
      });
      await p2;
    });

    it('stop does not hang when a start attempt is stuck in token minting', async () => {
      const fetchStarted = createDeferred<void>();
      fetchHappierVoiceToken.mockImplementationOnce(async (_credentials, options) => {
        fetchStarted.resolve();
        return new Promise((_, reject) => {
          const signal = options?.signal;
          if (!signal) return;
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      });

      const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession, endSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      void startRealtimeSession('s1', 'hi');
      await fetchStarted.promise;

      const stopPromise = stopRealtimeSession();
      const race = Promise.race([
        stopPromise.then(() => 'stopped' as const),
        sleep(100).then(() => 'timeout' as const),
      ]);

      expect(await race).toBe('stopped');
      await stopPromise;
      expect(endSession).toHaveBeenCalledTimes(1);
      expect(startSession).not.toHaveBeenCalled();
    });
  });
});
