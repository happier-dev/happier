import type {
  PluginVoiceConnectionDriver,
  PluginVoiceProviderConversationService,
  PluginVoiceProviderRuntimeRegistration,
  PluginVoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXaiRealtimeProviderRuntimeRegistration } from './createRuntimeContribution.js';

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

function createAccountOperations() {
  const request = vi.fn(async () => Object.freeze({
    status: 200,
    finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify({ value: 'short-lived' })),
  }));
  return { accountOperations: Object.freeze({ request }), request };
}

function createProviderConversation(
  conversationId: string | null = null,
): PluginVoiceProviderConversationService & {
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

function createConnection(): PluginVoiceRealtimeConnection {
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
  runtime: PluginVoiceProviderRuntimeRegistration,
  input: Readonly<{
    providerConfig?: unknown;
    providerConversation?: PluginVoiceProviderConversationService | null;
    reason?: 'initial' | 'reconnect' | 'auth_refresh';
  }> = {},
) {
  const account = createAccountOperations();
  const result = await runtime.protocol.prepare({
    controlSessionId: 'voice',
    attemptId: 1,
    reason: input.reason ?? 'initial',
    request: null,
    platform: 'web',
    providerConfig: input.providerConfig ?? {},
    accountOperations: account.accountOperations,
    providerConversation: input.providerConversation ?? null,
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
  it('keeps preflight credential-free and consumes current immutable settings for every prepare', async () => {
    const runtime = createXaiRealtimeProviderRuntimeRegistration();
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
    })).resolves.toEqual({
      kind: 'declined',
      code: 'voice_websocket_pcm_unsupported_platform',
    });

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

  it('uses public PCM media, current tools, and excludes auth from safe metadata', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntimeRegistration();
    const prepared = await prepare(runtime);
    expect(JSON.stringify(prepared.result.session.safeMetadata)).not.toContain('short-lived');

    let driver: PluginVoiceConnectionDriver | null = null;
    const waitForOutputDrain = vi.fn(async () => {});
    const clearOutput = vi.fn();
    const enqueueOutput = vi.fn(() => true);
    const connection = createConnection();
    const createPcmConnection = vi.fn((input) => {
      driver = input.driver;
      return Object.freeze({ connection, waitForOutputDrain, clearOutput, enqueueOutput });
    });
    const onOutputLevel = vi.fn();
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
        createWebRtcConnection: vi.fn(),
        createPcmConnection,
      }),
      tools: [SENTINEL_TOOL],
      ui: {} as never,
      signal: new AbortController().signal,
    });

    expect(returned).toBe(connection);
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

  it('delegates opt-in provider identity read, write, and forget to the host service', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntimeRegistration();
    const providerConversation = createProviderConversation('conv-old');
    const prepared = await prepare(runtime, {
      providerConfig: { resumptionEnabled: true },
      providerConversation,
    });
    expect(providerConversation.read).toHaveBeenCalledTimes(1);
    expect(prepared.result.session.config).toMatchObject({ conversationId: 'conv-old' });

    let driver: PluginVoiceConnectionDriver | null = null;
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
    expect(providerConversation.forget).toHaveBeenCalledTimes(1);
  });

  it('does not touch provider conversation state when resumption is disabled', async () => {
    const runtime = createXaiRealtimeProviderRuntimeRegistration();
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
    const runtime = createXaiRealtimeProviderRuntimeRegistration();
    const account = createAccountOperations();
    await expect(runtime.protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      platform: 'web',
      providerConfig: { resumptionEnabled: true },
      accountOperations: account.accountOperations,
      providerConversation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'declined',
      code: 'xai_resumption_persistence_unavailable',
    });
    expect(account.request).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toEqual([]);
  });
});
