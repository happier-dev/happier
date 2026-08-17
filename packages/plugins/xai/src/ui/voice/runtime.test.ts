import type {
  RealtimeVoiceProviderRuntime,
  VoiceConnectionMediaHost,
  VoiceProviderConversationService,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXaiRealtimeProviderRuntime } from './runtime.js';

const SENTINEL_TOOL = Object.freeze({
  name: 'sendSessionMessage',
  description: 'Send a message to the selected coding session.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ message: Object.freeze({ type: 'string' }) }),
  }),
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string, _protocols?: string | string[]) {
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

function createAccountOperations(responseBody: unknown = { value: 'short-lived' }) {
  const request = vi.fn(async () => Object.freeze({
    status: 200,
    finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify(responseBody)),
  }));
  return { accountOperations: Object.freeze({ request }), request };
}

function createProviderConversation(
  conversationId: string | null = null,
): VoiceProviderConversationService & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
} {
  return Object.freeze({
    read: vi.fn(async () => conversationId),
    write: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
  });
}

function createConnection(): VoiceRealtimeConnection {
  return Object.freeze({
    kind: 'websocket_pcm' as const,
    connect: vi.fn(async () => {}),
    sendControl: vi.fn(async () => {}),
    async *controlEvents() {},
    async *transportEvents() {},
    close: vi.fn(async () => {}),
    state: () => 'idle' as const,
    currentProviderSessionId: () => null,
    playbackCursorMs: () => 0,
    beginOutputInterruptionCandidate: () => Object.freeze({ kind: 'none' as const }),
    resolveOutputInterruptionCandidate: vi.fn(),
  });
}

async function prepare(
  runtime: RealtimeVoiceProviderRuntime,
  input: Readonly<{
    providerConfig?: unknown;
    providerConversation?: VoiceProviderConversationService | null;
    reason?: 'initial' | 'reconnect' | 'auth_refresh';
    accountResponse?: unknown;
    platform?: 'web' | 'ios' | 'android';
  }> = {},
) {
  const account = createAccountOperations(input.accountResponse);
  const result = await runtime.protocol.prepare({
    controlSessionId: 'voice',
    attemptId: 1,
    reason: input.reason ?? 'initial',
    request: null,
    platform: input.platform ?? 'web',
    providerConfig: input.providerConfig ?? {},
    credentials: Object.freeze({
      phase: 'prepare' as const,
      mediated: account.accountOperations,
      raw: null,
    }),
    providerConversation: input.providerConversation ?? null,
    hostedConversation: null,
    signal: new AbortController().signal,
  });
  if (result.kind !== 'prepared') throw new Error(`unexpected_prepare_result:${result.kind}`);
  return { result, ...account };
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
});

describe('xAI Realtime public runtime contribution', () => {
  type VoiceConnectionDriver = Parameters<VoiceConnectionMediaHost['createPcmConnection']>[0]['driver'];

  it('keeps preflight credential-free and consumes current immutable settings for every prepare', async () => {
    const runtime = createXaiRealtimeProviderRuntime();
    expect(runtime.kind).toBe('conversation');
    const signal = new AbortController().signal;
    await expect(runtime.protocol.preflight?.({
      controlSessionId: 'voice',
      attemptId: 1,
      request: null,
      platform: 'web',
      providerConfig: { voice: { kind: 'catalog', id: 'eve' } },
      signal,
    })).resolves.toEqual({ kind: 'ready' });
    await expect(runtime.protocol.preflight?.({
      controlSessionId: 'voice',
      attemptId: 1,
      request: null,
      platform: 'ios',
      providerConfig: {},
      signal,
    })).resolves.toEqual({ kind: 'ready' });

    for (const platform of ['ios', 'android'] as const) {
      const native = await prepare(runtime, { platform });
      expect(native.result.session.config.auth).toMatchObject({
        kind: 'bearer_token',
        placement: 'authorization_header',
      });
    }

    const initial = await prepare(runtime, {
      providerConfig: { voice: { kind: 'catalog', id: 'eve' }, instructions: 'first' },
    });
    const refreshed = await prepare(runtime, {
      reason: 'auth_refresh',
      providerConfig: { voice: { kind: 'catalog', id: 'ara' }, instructions: 'current' },
    });

    expect(initial.result.session.config).toMatchObject({
      settings: { voice: { id: 'eve' }, instructions: 'first' },
    });
    expect(refreshed.result.session.config).toMatchObject({
      settings: { voice: { id: 'ara' }, instructions: 'current' },
    });
    expect(initial.request).toHaveBeenCalledTimes(1);
    expect(refreshed.request).toHaveBeenCalledTimes(1);
  });

  it('uses only settings-phase mediated access for the voice catalog', async () => {
    const runtime = createXaiRealtimeProviderRuntime();
    const request = vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.x.ai/v1/tts/voices',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        voices: [{ voice_id: 'eve', name: 'Eve' }],
      })),
    }));

    await expect(runtime.settingsOperations?.listCatalog?.({
      catalog: 'voices',
      providerConfig: {},
      credentials: {
        phase: 'settings',
        mediated: Object.freeze({ request }),
        raw: null,
      },
      signal: new AbortController().signal,
    })).resolves.toEqual([{ id: 'eve', name: 'Eve', metadata: {} }]);
    expect(request).toHaveBeenCalledTimes(1);

    await expect(runtime.settingsOperations?.listCatalog?.({
      catalog: 'voices',
      providerConfig: {},
      credentials: { phase: 'settings', mediated: null, raw: null },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses public PCM media, current tools, and excludes auth from safe metadata', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();
    const prepared = await prepare(runtime);
    expect(JSON.stringify(prepared.result.session.safeMetadata)).not.toContain('short-lived');
    expect(prepared.result.session.safeMetadata).not.toHaveProperty('providerId');

    let driver: VoiceConnectionDriver | null = null;
    const waitForOutputDrain = vi.fn(async () => {});
    const clearOutput = vi.fn();
    const enqueueOutput = vi.fn(() => true);
    const connection = createConnection();
    const createPcmConnection = vi.fn((input) => {
      driver = input.driver;
      return Object.freeze({ connection, waitForOutputDrain, clearOutput, enqueueOutput });
    });
    const onOutputLevel = vi.fn();
    const connectionCredentialRequest = vi.fn(async () => {
      throw new Error('connection_credentials_must_not_be_used');
    });
    const returned = await runtime.createConnection({
      session: prepared.result.session,
      attemptId: 1,
      mic: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: () => false,
        teardown: vi.fn(async () => {}),
        getStream: () => null,
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel },
      media: Object.freeze({
        createSdkHandleConnection: vi.fn(),
        createWebRtcConnection: vi.fn(),
        createPcmConnection,
      }),
      tools: [SENTINEL_TOOL],
      ui: {} as never,
      signal: new AbortController().signal,
      credentials: {
        phase: 'connection',
        mediated: { request: connectionCredentialRequest },
        raw: null,
      },
    });

    expect(returned).toBe(connection);
    expect(connectionCredentialRequest).not.toHaveBeenCalled();
    expect(createPcmConnection).toHaveBeenCalledWith(expect.objectContaining({
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
      onInputChunk: expect.any(Function),
    }));
    await driver!.open({
      signal: new AbortController().signal,
      onControl: vi.fn(),
      onTransport: vi.fn(),
      onRemoteClose: vi.fn(),
    });
    expect(FakeWebSocket.instances.at(-1)?.sent.map(JSON.parse)).toEqual([{
      type: 'session.update',
      session: expect.objectContaining({
        tools: [{ type: 'function', ...SENTINEL_TOOL }],
      }),
    }]);

    const signal = new AbortController().signal;
    await runtime.beforeToolContinuation?.('response-1', signal);
    expect(waitForOutputDrain).toHaveBeenCalledWith(signal);
    await runtime.beforeInterrupt?.();
    expect(clearOutput).toHaveBeenCalledTimes(1);
  });

  it('rejects client auth that expires while media setup is deferred', async () => {
    const preparedAtMs = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(preparedAtMs);
    try {
      const runtime = createXaiRealtimeProviderRuntime();
      const prepared = await prepare(runtime, {
        accountResponse: {
          value: 'short-lived',
          expires_at: (preparedAtMs + 2_000) / 1_000,
        },
      });
      const createPcmConnection = vi.fn(() => Object.freeze({
        connection: createConnection(),
        enqueueOutput: vi.fn(() => true),
        clearOutput: vi.fn(),
        waitForOutputDrain: vi.fn(async () => {}),
      }));
      dateNow.mockReturnValue(preparedAtMs + 1_001);

      await expect(runtime.createConnection({
        session: prepared.result.session,
        attemptId: 1,
        mic: {
          ensureActive: vi.fn(async () => {}),
          setMuted: vi.fn(),
          isMuted: () => false,
          teardown: vi.fn(async () => {}),
          getStream: () => null,
        },
        interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
        levels: { onOutputLevel: vi.fn() },
        media: Object.freeze({
          createSdkHandleConnection: vi.fn(),
          createWebRtcConnection: vi.fn(),
          createPcmConnection,
        }),
        tools: [],
        ui: {} as never,
        signal: new AbortController().signal,
        credentials: { phase: 'connection', mediated: null, raw: null },
      })).rejects.toMatchObject({ code: 'voice_auth_expired' });
      expect(prepared.request).toHaveBeenCalledOnce();
      expect(createPcmConnection).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toEqual([]);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('delegates opt-in provider identity read and write while durable Forget remains host-owned', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();
    const providerConversation = createProviderConversation('conv-old');
    const prepared = await prepare(runtime, {
      providerConfig: { resumptionEnabled: true },
      providerConversation,
    });
    expect(providerConversation.read).toHaveBeenCalledTimes(1);
    expect(prepared.result.session.config).toMatchObject({ conversationId: 'conv-old' });

    let driver: VoiceConnectionDriver | null = null;
    const clearOutput = vi.fn();
    await runtime.createConnection({
      session: prepared.result.session,
      attemptId: 1,
      mic: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: () => false,
        teardown: vi.fn(async () => {}),
        getStream: () => null,
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: Object.freeze({
        createSdkHandleConnection: vi.fn(),
        createWebRtcConnection: vi.fn(),
        createPcmConnection: vi.fn((input) => {
          driver = input.driver;
          return Object.freeze({
            connection: createConnection(),
            enqueueOutput: vi.fn(() => true),
            clearOutput,
            waitForOutputDrain: vi.fn(async () => {}),
          });
        }),
      }),
      tools: [],
      ui: {} as never,
      signal: new AbortController().signal,
      credentials: { phase: 'connection', mediated: null, raw: null },
    });
    await driver!.open({
      signal: new AbortController().signal,
      onControl: vi.fn(),
      onTransport: vi.fn(),
      onRemoteClose: vi.fn(),
    });
    expect(new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get('conversation_id'))
      .toBe('conv-old');
    FakeWebSocket.instances.at(-1)!.emitConversationId('conv-fresh');
    await vi.waitFor(() => expect(providerConversation.write).toHaveBeenCalledWith('conv-fresh'));

    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice',
      attemptId: 0,
      reason: { code: 'stopped' },
    });
    await runtime.beforeInterrupt?.();
    expect(clearOutput).toHaveBeenCalledTimes(1);
    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: { code: 'stopped' },
    });
    await runtime.forgetProviderConversation?.();
    expect(providerConversation.forget).not.toHaveBeenCalled();
  });

  it('does not touch provider conversation state when resumption is disabled', async () => {
    const runtime = createXaiRealtimeProviderRuntime();
    const providerConversation = createProviderConversation('must-not-load');
    const prepared = await prepare(runtime, {
      providerConfig: { resumptionEnabled: false },
      providerConversation,
    });
    expect(prepared.result.session.config).toMatchObject({ conversationId: null });
    await runtime.forgetProviderConversation?.();
    expect(providerConversation.read).not.toHaveBeenCalled();
    expect(providerConversation.write).not.toHaveBeenCalled();
    expect(providerConversation.forget).not.toHaveBeenCalled();
  });

  it('fails before auth or transport when resumption is enabled without persistent host conversation ownership', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();
    const account = createAccountOperations();
    await expect(runtime.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      platform: 'web',
      providerConfig: { resumptionEnabled: true },
      credentials: Object.freeze({
        phase: 'prepare' as const,
        mediated: account.accountOperations,
        raw: null,
      }),
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'declined',
      code: 'xai_resumption_persistence_unavailable',
    });
    expect(account.request).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it('fails closed before transport when prepare-phase mediated access is unavailable', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();

    await expect(runtime.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      platform: 'web',
      providerConfig: {},
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'declined',
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(FakeWebSocket.instances).toEqual([]);
  });
});
