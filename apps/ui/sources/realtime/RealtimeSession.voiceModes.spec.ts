import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSession } from './types';

const modalAlert = vi.fn();
const modalConfirm = vi.fn(async () => false);
const modalPrompt = vi.fn(async () => null);

vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlert,
    confirm: modalConfirm,
    prompt: modalPrompt,
  },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));

const getCredentials = vi.fn(async () => ({ token: 't', secret: 's' }));
vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: { getCredentials },
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
  voiceProviderId: string;
  voiceByoElevenLabsAgentId: string | null;
  voiceByoElevenLabsApiKey: { value?: string } | null;
  voiceAssistantLanguage: string | null;
};

const defaultSettings: TestSettings = {
  experiments: false,
  voiceProviderId: 'happier_elevenlabs_agents',
  voiceByoElevenLabsAgentId: null,
  voiceByoElevenLabsApiKey: null,
  voiceAssistantLanguage: null,
};

const state: {
  settings: TestSettings;
  profile: { id: string };
  setRealtimeStatus: ReturnType<typeof vi.fn>;
  setRealtimeMode: ReturnType<typeof vi.fn>;
  clearRealtimeModeDebounce: ReturnType<typeof vi.fn>;
} = {
  settings: { ...defaultSettings },
  profile: { id: 'u1' },
  setRealtimeStatus: vi.fn(),
  setRealtimeMode: vi.fn(),
  clearRealtimeModeDebounce: vi.fn(),
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => state },
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

describe('Realtime voice modes', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    state.settings = { ...defaultSettings };
    state.setRealtimeStatus.mockReset();
    state.setRealtimeMode.mockReset();
    state.clearRealtimeModeDebounce.mockReset();
    installFetchMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('provider selection', () => {
    it('does nothing when voice provider is off', async () => {
      state.settings.voiceProviderId = 'off';
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_0');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows an error when BYO is selected but not configured', async () => {
      state.settings.voiceProviderId = 'byo_elevenlabs_agents';
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
    it('starts Happier Voice via server token minting', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          allowed: true,
          token: 'conv_token',
          leaseId: 'lease_1',
          expiresAtMs: Date.now() + 60_000,
        }),
      );

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'conv_token' }));
    });

    it('does not mark the voice session started when provider returns no conversation id', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          allowed: true,
          token: 'conv_token',
          leaseId: 'lease_1',
          expiresAtMs: Date.now() + 60_000,
        }),
      );

      const { registerVoiceSession, startRealtimeSession, isVoiceSessionStarted } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession(null);
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'conv_token' }));
      expect(isVoiceSessionStarted()).toBe(false);
    });

    it('completes usage on stop for Happier Voice sessions', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(
          createJsonResponse({
            allowed: true,
            token: 'conv_token',
            leaseId: 'lease_1',
            expiresAtMs: Date.now() + 60_000,
          }),
        )
        .mockResolvedValueOnce(createJsonResponse({ ok: true, durationSeconds: 10 }));

      const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
      const { session, endSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      await startRealtimeSession('s1', 'hi');
      await stopRealtimeSession();

      expect(endSession).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/voice/session/complete'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ leaseId: 'lease_1', providerConversationId: 'conv_1' }),
        }),
      );
    });

    it('retries after paywall purchase without deadlocking', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock
          .mockResolvedValueOnce(createJsonResponse({ allowed: false, reason: 'subscription_required' }))
          .mockResolvedValueOnce(
            createJsonResponse({
              allowed: true,
              token: 'conv_token',
              leaseId: 'lease_1',
              expiresAtMs: Date.now() + 60_000,
            }),
          );

        const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
        const { session, startSession } = makeVoiceSession('conv_1');
        registerVoiceSession(session);

        const startPromise = startRealtimeSession('s1', 'hi');
        const race = Promise.race([
          startPromise.then(() => 'resolved' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1)),
        ]);
        await vi.advanceTimersByTimeAsync(1);

        expect(await race).toBe('resolved');
        expect(presentPaywall).toHaveBeenCalledTimes(1);
        expect(startSession).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('concurrency and stop behavior', () => {
    it('dedupes concurrent start calls for the same session', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          allowed: true,
          token: 'conv_token',
          leaseId: 'lease_1',
          expiresAtMs: Date.now() + 60_000,
        }),
      );

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      const p1 = startRealtimeSession('s1', 'hi');
      const p2 = startRealtimeSession('s1', 'hi');
      await Promise.all([p1, p2]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledTimes(1);
    });

    it('rejects start when a different session is already starting', async () => {
      const fetchStarted = createDeferred<void>();
      const neverResolves = createDeferred<Response>();
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementationOnce(async () => {
        fetchStarted.resolve();
        return neverResolves.promise;
      });

      const { registerVoiceSession, startRealtimeSession } = await import('./RealtimeSession');
      const { session, startSession } = makeVoiceSession('conv_1');
      registerVoiceSession(session);

      void startRealtimeSession('s1', 'hi');
      await fetchStarted.promise;
      await startRealtimeSession('s2', 'hi');

      expect(modalAlert).toHaveBeenCalledWith('common.error', 'errors.voiceAlreadyStarting');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(startSession).not.toHaveBeenCalled();
    });

    it('stop does not hang when a start attempt is stuck in token minting', async () => {
      vi.useFakeTimers();
      try {
        const fetchStarted = createDeferred<void>();
        const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
          fetchStarted.resolve();
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
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
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
        ]);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await race).toBe('stopped');
        expect(endSession).toHaveBeenCalledTimes(1);
        expect(startSession).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
