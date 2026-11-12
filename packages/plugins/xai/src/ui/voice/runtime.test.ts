import type {
  RealtimeVoiceProviderRuntime,
  VoiceConnectionMediaHost,
  VoiceProviderConversationService,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

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

function createAccountOperations(responseBody?: unknown) {
  // xAI's client-secret contract makes `expires_at` a required integer
  // unix-seconds field, and the broker no longer invents one when it is absent,
  // so the default fixture states the documented response shape.
  const body = responseBody ?? Object.freeze({
    value: 'short-lived',
    expires_at: Math.floor(Date.now() / 1_000) + 300,
  });
  const request = vi.fn(async () => Object.freeze({
    status: 200,
    finalUrl: 'https://api.x.ai/v1/realtime/client_secrets',
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify(body)),
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
    attemptPolicy?: Parameters<RealtimeVoiceProviderRuntime['protocol']['prepare']>[0]['attemptPolicy'];
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
    attemptPolicy: input.attemptPolicy,
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

  it.each(['completed', 'cancelled', 'interrupted', 'unrelated', 'model', 'legacy_media'] as const)('proves the forced host summary and audible tail (%s)', async outcome => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();
    const prepared = await prepare(runtime);
    let driver!: VoiceConnectionDriver;
    let finishDrain!: (result: 'completed' | 'cancelled') => void;
    let noteDrain!: () => void;
    const draining = new Promise<void>(resolve => { noteDrain = resolve; });
    const tail = new Promise<'completed' | 'cancelled'>(resolve => { finishDrain = resolve; });
    const captureOutputPlayback = vi.fn(() => {
      expect(FakeWebSocket.instances.at(-1)!.sent.map(raw => JSON.parse(raw).type)).not.toContain('conversation.item.create');
      return { waitForDrain: async () => { noteDrain(); return await tail; } };
    });
    await runtime.createConnection({
      session: prepared.result.session, attemptId: 1, mic: { getStream: () => null },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 }, levels: { onOutputLevel: vi.fn() },
      media: { createSdkHandleConnection: () => { throw new Error('unexpected'); }, createWebRtcConnection: () => { throw new Error('unexpected'); },
        createPcmConnection: input => {
          driver = input.driver;
          return { connection: createConnection(), enqueueOutput: () => true, clearOutput: () => {},
            ...(outcome === 'legacy_media' ? {} : { captureOutputPlayback }),
            waitForOutputDrain: async () => { noteDrain(); return await tail; } };
        } },
      tools: [], ui: {} as never, signal: new AbortController().signal,
      credentials: { phase: 'connection', mediated: null, raw: null }, execution: { kind: 'direct_media' },
    });
    await driver.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose: vi.fn() });
    expect(runtime.playHostText).toBeTypeOf('function');
    const controller = new AbortController();
    let settled = false;
    const speaking = runtime.playHostText!({ text: 'Remove the webhook.', signal: controller.signal }).then(result => { settled = true; return result; });
    const socket = FakeWebSocket.instances.at(-1)!;
    if (outcome === 'legacy_media') {
      expect(socket.sent.map(raw => JSON.parse(raw).type)).not.toContain('conversation.item.create');
      expect(await speaking).toEqual({ status: 'unavailable', code: 'host_text_playback_unavailable' });
      await driver.close({ code: 'user_stop' });
      return;
    }
    expect(captureOutputPlayback).toHaveBeenCalledOnce();
    const forced = JSON.parse(socket.sent.at(-1)!);
    expect(socket.sent.map(raw => JSON.parse(raw)).at(-1)).toMatchObject({ type: 'conversation.item.create', item: {
      type: 'force_message', content: [{ type: 'output_text', text: 'Remove the webhook.' }],
    } });
    const emit = (event: unknown) => socket.emit('message', { data: JSON.stringify(event) });
    emit({ type: 'response.created', response: { id: 'host-response' } });
    const itemId = outcome === 'model' ? 'model-item' : forced.item.id;
    emit({ type: 'response.output_audio.delta', response_id: 'host-response', item_id: itemId, delta: 'AQACAA==' });
    emit({ type: 'response.output_audio_transcript.done', response_id: 'host-response', item_id: itemId, transcript: outcome === 'unrelated' ? 'Okay.' : 'Remove the webhook.' });
    emit({ type: 'response.done', response: { id: 'host-response', status: 'completed' } });
    if (outcome === 'unrelated' || outcome === 'model') {
      finishDrain('completed');
      expect(await speaking).toEqual({ status: 'unavailable', code: 'host_text_playback_unavailable' });
    } else {
      await draining;
      expect(settled).toBe(false);
      if (outcome === 'interrupted') await runtime.beforeInterrupt?.();
      finishDrain(outcome === 'cancelled' ? 'cancelled' : 'completed');
      expect(await speaking).toEqual({ status: outcome === 'completed' ? 'completed' : 'cancelled' });
    }
    await driver.close({ code: 'user_stop' });
  });

  it.each([
    ['initial', 'immediate', true],
    ['reconnect', 'immediate', false],
    ['auth_refresh', 'immediate', false],
    ['initial', 'on_first_turn', false],
  ] as const)('starts welcome only after the initial session update (%s, %s)', async (reason, mode, shouldGreet) => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const runtime = createXaiRealtimeProviderRuntime();
    const prepared = await prepare(runtime, { reason, attemptPolicy: {
      instructions: 'Greet briefly, then wait.', assistantLanguage: null,
      welcome: { enabled: true, mode },
    } });
    let driver: VoiceConnectionDriver | null = null;
    await runtime.createConnection({
      session: prepared.result.session, attemptId: 1, mic: { getStream: () => null },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 }, levels: { onOutputLevel: vi.fn() },
      media: {
        createWebRtcConnection: vi.fn(), createSdkHandleConnection: vi.fn(),
        createPcmConnection: (input) => {
          driver = input.driver;
          return { connection: createConnection(), enqueueOutput: () => true,
            clearOutput: () => {}, waitForOutputDrain: async () => {} };
        },
      },
      tools: [], ui: {} as never, signal: new AbortController().signal,
      credentials: { phase: 'connection', mediated: null, raw: null }, execution: { kind: 'direct_media' },
    });
    await driver!.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose: vi.fn() });
    expect(FakeWebSocket.instances.at(-1)!.sent.map((value) => JSON.parse(value).type))
      .toEqual(shouldGreet ? ['session.update', 'response.create'] : ['session.update']);
  });

  it('retains admitted custom instructions across reconnect while other provider settings remain current', async () => {
    const runtime = createXaiRealtimeProviderRuntime();
    const attemptPolicy = {
      instructions: 'Use only the admitted tools.', assistantLanguage: null,
      welcome: { enabled: false, mode: 'immediate' as const },
    };
    await prepare(runtime, {
      attemptPolicy, providerConfig: { instructions: 'Use project terminology.', voice: { kind: 'catalog', id: 'eve' } },
    });
    const reconnect = await prepare(runtime, {
      reason: 'reconnect', attemptPolicy,
      providerConfig: { instructions: 'New instructions for the next attempt.', voice: { kind: 'catalog', id: 'ara' } },
    });
    expect(reconnect.result.session.config).toMatchObject({
      instructions: 'Use only the admitted tools.\n\nUse project terminology.',
      settings: { voice: { id: 'ara' } },
    });
    await runtime.protocol.releasePrepared?.({
      controlSessionId: 'voice', attemptId: 1, reason: { code: 'user_stop' },
    });
    const next = await prepare(runtime, {
      attemptPolicy, providerConfig: { instructions: 'New instructions for the next attempt.' },
    });
    expect(next.result.session.config.instructions)
      .toBe('Use only the admitted tools.\n\nNew instructions for the next attempt.');
  });

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
    const prepared = await prepare(runtime, {
      providerConfig: { instructions: 'Use project terminology.' },
      attemptPolicy: {
        instructions: 'Only use admitted tools. Reply in fr-FR.',
        assistantLanguage: 'fr-FR', welcome: { enabled: false, mode: 'immediate' },
      },
    });
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
      output: { sampleRate: 24_000 },
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
        tools: [{ type: 'function', name: SENTINEL_TOOL.name, description: SENTINEL_TOOL.description,
          parameters: { type: 'object', required: ['arguments_json'], properties: {
            arguments_json: { type: 'string', description: expect.stringContaining(JSON.stringify(SENTINEL_TOOL.parameters)) },
          } },
        }],
        instructions: expect.stringContaining('Only use admitted tools. Reply in fr-FR.'),
      }),
    }]);
    expect(JSON.parse(FakeWebSocket.instances.at(-1)!.sent[0]!).session.instructions)
      .toContain('Use project terminology.');

    // Provider semantic completion means the server stopped sending audio, not
    // that the host finished rendering the buffered tail. The measured playback
    // meter belongs to the host audio scheduler alone.
    FakeWebSocket.instances.at(-1)?.emit('message', {
      data: JSON.stringify({
        type: 'response.output_audio.done',
        response_id: 'response-1',
        item_id: 'assistant-1',
      }),
    });
    expect(onOutputLevel).not.toHaveBeenCalled();

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
