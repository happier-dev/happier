import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import type { Callbacks } from '@elevenlabs/client';
import type { ElevenLabsConversationHandleEvent } from './conversationHandle.js';

import { createElevenLabsSdkConnection } from './sdkConnection.js';
import { createElevenLabsConversationHandle } from './conversationHandle.js';
import { createElevenLabsSessionPreparationService } from './sessionPreparation.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../../protocol/voice/index.js';
// Exercise the same host connection lifecycle injected into the plugin in production.
// Dynamic import keeps the plugin's TypeScript build rooted at its public SDK seam.
const hostConnectionUrl = new URL(
  '../../../../../../../apps/ui/sources/voice/runtime/connection/VoiceRealtimeConnection.ts',
  import.meta.url,
);
const { createSdkHandleConnection } = await import(/* @vite-ignore */ hostConnectionUrl.href) as Readonly<{
  createSdkHandleConnection: Parameters<typeof createElevenLabsSdkConnection>[0]['createSdkHandleConnection'];
}>;

describe('createElevenLabsSdkConnection', () => {
  it.each([1006, 1013])('retains native socket close %s from real SDK startup', async (closeCode) => {
    class ProviderSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), {
          code: closeCode, reason: 'private-provider-close-reason',
        })));
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', ProviderSocket);
    const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') });
    const connection = createElevenLabsSdkConnection({ createSdkHandleConnection, handle,
      startConfig: { textOnly: true, signedUrl: 'wss://fixture.invalid' }, duckGain: 0.18 });
    try {
      await expect(connection.connect(new AbortController().signal)).rejects.toMatchObject({
        message: 'voice_service_unavailable', failureCause: {
          phase: 'elevenlabs.session.start', errorClass: 'Error', nativeErrorCode: String(closeCode),
        },
      });
    } finally {
      await connection.close({ code: 'user_stop' });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { error: new TypeError('private-vendor-send-error'),
      cause: { phase: 'elevenlabs.control.send', errorClass: 'TypeError', errorCode: null, httpStatus: null } },
    { error: Object.assign(new Error('private-vendor-send-error'), { response: { status: 429 } }),
      cause: { phase: 'elevenlabs.control.send', errorClass: 'Error', errorCode: null, httpStatus: 429 } },
    { error: Object.assign(new Error('private-vendor-send-error'), { code: 'private-vendor-code', status: 429 }),
      cause: { phase: 'elevenlabs.control.send', errorClass: 'Error', errorCode: null, httpStatus: 429 } },
    { error: Object.assign(new Error('private-vendor-send-error'), { failureCause: {
      phase: 'elevenlabs.control.publish', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: 429 } }),
      cause: { phase: 'elevenlabs.control.publish', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: 429 } },
  ])('retains the vendor send cause $cause without exposing vendor text', async ({ error, cause }) => {
    // Vendor session is the external boundary; keep the real handle and host connection beneath it.
    const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: async () => ({
      Conversation: { startSession: async () => ({
        getId: () => 'failed-send', endSession: async () => {}, setMicMuted: () => {}, setVolume: () => {},
        sendUserMessage: () => { throw error; }, sendContextualUpdate: () => {},
      }) },
    }) as unknown as Pick<typeof import('@elevenlabs/client'), 'Conversation'> });
    const connection = createElevenLabsSdkConnection({ createSdkHandleConnection, handle, startConfig: {}, duckGain: 0.18 });
    try {
      await connection.connect(new AbortController().signal);
      await expect(connection.sendControl({ type: 'voice.user_text', text: 'hello' }))
        .rejects.toMatchObject({ message: 'voice_service_unavailable', failureCause: cause });
      const control = connection.controlEvents(new AbortController().signal)[Symbol.asyncIterator]();
      const failure = (await control.next()).value;
      const { createElevenLabsVoiceProviderRuntime } = await import('../runtime.js');
      const runtime = createElevenLabsVoiceProviderRuntime({ loadConversationSdk: () => import('@elevenlabs/client') });
      expect(runtime.protocol.decodeControl(failure)).toEqual([{ type: 'provider_error', terminal: true,
        code: 'voice_service_unavailable', failureCause: cause }]);
      expect(JSON.stringify(failure)).not.toContain('private-vendor');
      await runtime.dispose();
    } finally {
      await connection.close({ code: 'user_stop' });
    }
  });

  it.each(['inherited-voice', 'selected-voice'])('sends the prepared %s through the real SDK encoder after settings change', async (voiceId) => {
    const sent: unknown[] = [];
    class ProviderSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(data: string) {
        const event: unknown = JSON.parse(data);
        sent.push(event);
        if ((event as Readonly<{ type?: unknown }>).type === 'conversation_initiation_client_data') {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
            type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
              conversation_id: 'voice-override', agent_output_audio_format: 'pcm_16000',
            },
          }) })));
        }
      }
      close() {}
    }
    // Only the vendor WebSocket is replaced. Preparation, handle lifecycle,
    // SDK startup and the vendor's camelCase → native wire encoder remain real.
    let settings = ElevenLabsVoiceProviderSettingsSchema.parse({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, voiceId, modelId: 'inherited-model',
        voiceSettings: { stability: 0.4, similarityBoost: 0.8, speed: 1.1 } },
    });
    const preparation = createElevenLabsSessionPreparationService({
      providerId: 'elevenlabs', alert() {},
      projectVoiceSettings: (providerConfig) => ({ providerId: 'elevenlabs', assistantLanguage: null, providerConfig }),
    });
    const prepared = await preparation.prepare({
      controlSessionId: 'voice-control', requestedTargetSessionId: null, settings,
      credentials: { phase: 'prepare', mediated: null, raw: null },
      hostedConversation: {
        start: async () => ({ allowed: true, token: 'hosted-token', leaseId: 'lease', bindingNonce: 'nonce', expiresAtMs: 1000 }),
        abort: async () => {}, complete: async () => {},
      },
      signal: new AbortController().signal, platform: 'web', textOnly: true,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    settings = ElevenLabsVoiceProviderSettingsSchema.parse({
      ...settings, tts: { ...settings.tts, voiceId: 'later-voice' },
    });
    const config = preparation.buildStartConfig({ prepared: prepared.session, settings });
    expect(config).toMatchObject({ conversationToken: 'hosted-token' });
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection, handle: createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') }),
      startConfig: { ...(config as Record<string, unknown>), connectionType: 'websocket', signedUrl: 'wss://provider.test/voice' },
      duckGain: 0.18,
    });
    vi.stubGlobal('WebSocket', ProviderSocket);
    try {
      await connection.connect(new AbortController().signal);
      expect(sent[0]).toMatchObject({ conversation_config_override: { tts: { voice_id: voiceId } } });
      expect(sent[0]).not.toHaveProperty('conversation_config_override.tts.speed');
      expect(sent[0]).not.toHaveProperty('conversation_config_override.tts.model_id');
      expect(connection.currentProviderSessionId()).toBe('voice-override');
    } finally {
      await connection.close({ code: 'user_stop' });
      vi.unstubAllGlobals();
    }
  });

  it.each([undefined, { clientToolName: 'readSession', toolCallId: 'provider-call' }])(
    'keeps recoverable client-tool errors alive while terminal errors still close the session (%j)', async (terminalContext) => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const handle = {
      startSession: vi.fn(async () => 'tool-errors'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(), sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(), setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: () => 'tool-errors', dispose: vi.fn(),
      subscribe(listener: typeof publish) { publish = listener; return () => {}; },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection, handle, startConfig: {}, duckGain: 0.18,
    });
    await connection.connect(new AbortController().signal);
    publish({ type: 'error', error: 'tool failed', context: { clientToolName: 'readSession' } } as ElevenLabsConversationHandleEvent);
    await connection.sendControl({ type: 'voice.user_text', text: 'continue' });
    expect(connection.state()).toBe('open');
    expect(handle.endSession).not.toHaveBeenCalled();
    expect(handle.sendUserMessage).toHaveBeenCalledWith('continue');
    publish({ type: 'error', error: 'terminal failure', context: terminalContext });
    const controls = connection.controlEvents(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(controls.next()).resolves.toMatchObject({ value: { type: 'elevenlabs.session_error',
      failureCause: { phase: 'elevenlabs.sdk.error' } } });
    await connection.close({ code: 'error' });
    expect(handle.endSession).toHaveBeenCalledTimes(1);
  });
  it('owns the SDK lifecycle and projects callbacks through connection channels', async () => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const handle = {
      startSession: vi.fn(async () => 'conversation-1'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => 'conversation-1'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return () => {};
      },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: { signedUrl: 'wss://example.test/session' },
      duckGain: 0.18,
    });
    const signal = new AbortController().signal;

    await connection.connect(signal);
    expect(handle.startSession).toHaveBeenCalledWith({ signedUrl: 'wss://example.test/session' });
    expect(handle.setMicMuted).toHaveBeenCalledWith(false);
    const providerMessage: Parameters<NonNullable<Callbacks['onMessage']>>[0] = {
      source: 'ai',
      role: 'agent',
      message: 'provider message',
    };
    publish({ type: 'message', data: providerMessage });
    publish({
      type: 'agent_response_correction',
      data: {
        original_agent_response: 'provider message',
        corrected_agent_response: 'corrected provider message',
        event_id: 11,
      },
    });
    publish({ type: 'mode', data: { mode: 'speaking' as never } });
    const controls = connection.controlEvents(signal)[Symbol.asyncIterator]();
    await expect(controls.next()).resolves.toEqual({
      done: false,
      value: providerMessage,
    });
    // The correction reaches the transcript ladder on the same control channel
    // as every other provider observation, in ElevenLabs' own wire envelope.
    await expect(controls.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'agent_response_correction',
        agent_response_correction_event: {
          original_agent_response: 'provider message',
          corrected_agent_response: 'corrected provider message',
          event_id: 11,
        },
      },
    });
    await expect(controls.next()).resolves.toEqual({
      done: false,
      value: { type: 'elevenlabs.mode', mode: 'speaking' },
    });

    const transport = connection.transportEvents(signal)[Symbol.asyncIterator]();
    await expect(transport.next()).resolves.toEqual({
      done: false,
      value: { type: 'session_identity', sessionId: 'conversation-1' },
    });
    await connection.close({ code: 'user_stop' });
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not apply microphone state after a text-only session establishes provider identity', async () => {
    const setMicMuted = vi.fn(() => {
      throw new Error('setMicMuted is not supported in text conversations');
    });
    const handle = {
      startSession: vi.fn(async () => 'conversation-text-only'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted,
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => 'conversation-text-only'),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: { textOnly: true },
      initialMuted: false,
      duckGain: 0.18,
    });

    await expect(connection.connect(new AbortController().signal)).resolves.toBeUndefined();
    expect(connection.currentProviderSessionId()).toBe('conversation-text-only');
    expect(connection.state()).toBe('open');
    expect(setMicMuted).not.toHaveBeenCalled();
  });

  it('maps provider-neutral focus states to the SDK output-volume handle', () => {
    const setOutputVolume = vi.fn();
    const handle = {
      startSession: vi.fn(async () => 'conversation-focus'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume,
      settleToolResult: vi.fn(),
      getId: vi.fn(() => 'conversation-focus'),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });

    expect(connection.setOutputFocusState?.('suspended')).toBe('applied');
    expect(connection.setOutputFocusState?.('ducked')).toBe('applied');
    expect(connection.setOutputFocusState?.('active')).toBe('applied');
    expect(setOutputVolume.mock.calls).toEqual([[0], [0.18], [1]]);
  });

  it('translates canonical SDK commands and publishes terminal disconnect cause for the host', async () => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const dispose = vi.fn();
    const handle = {
      startSession: vi.fn(async () => 'conversation-2'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => 'conversation-2'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return dispose;
      },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });
    await connection.connect(new AbortController().signal);

    await connection.sendControl({ type: 'voice.user_text', text: 'hello' });
    await connection.sendControl({ type: 'voice.context_update', text: 'context' });
    await connection.sendControl({ type: 'voice.input_muted', muted: true });
    expect(handle.sendUserMessage).toHaveBeenCalledWith('hello');
    expect(handle.sendContextualUpdate).toHaveBeenCalledWith('context');
    expect(handle.setMicMuted).toHaveBeenCalledWith(true);

    publish({ type: 'disconnect', reason: 'network_lost' });
    const controls = connection.controlEvents(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(controls.next()).resolves.toMatchObject({ value: { type: 'elevenlabs.session_error',
      failureCause: { phase: 'elevenlabs.disconnect' } } });
    await connection.close({ code: 'error' });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledTimes(1));
  });

  it('ends the SDK session once when a disconnect races with start completion', async () => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const handle = {
      startSession: vi.fn(async () => {
        publish({ type: 'disconnect', reason: 'closed_during_start' });
        return 'racing-session';
      }),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => 'racing-session'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return () => {};
      },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });

    await expect(connection.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'voice_service_unavailable',
      failureCause: { phase: 'elevenlabs.disconnect' } });
    await vi.waitFor(() => expect(handle.endSession).toHaveBeenCalled());
    expect(handle.endSession).toHaveBeenCalledTimes(1);
  });

  it('ends a late SDK start after abort and ignores its stale session identity', async () => {
    let resolveStart!: (value: string | null) => void;
    const handle = {
      startSession: vi.fn(async () => await new Promise<string | null>((resolve) => { resolveStart = resolve; })),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });
    const controller = new AbortController();
    const connecting = connection.connect(controller.signal);
    await vi.waitFor(() => expect(handle.startSession).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveStart('late-session');

    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(handle.endSession).toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(connection.state()).toBe('closed');
  });

  it('settles the Happier connection while SDK setup remains indefinitely pending', async () => {
    const handle = {
      startSession: vi.fn(async () => await new Promise<string | null>(() => {})),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });
    const controller = new AbortController();
    const connecting = connection.connect(controller.signal);
    await vi.waitFor(() => expect(handle.startSession).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.state()).toBe('closed');
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a late SDK setup rejection inert after attempt abort', async () => {
    let rejectStart!: (error: Error) => void;
    const handle = {
      startSession: vi.fn(async () => await new Promise<string | null>((_resolve, reject) => {
        rejectStart = reject;
      })),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });
    const controller = new AbortController();
    const connecting = connection.connect(controller.signal);
    await vi.waitFor(() => expect(handle.startSession).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    rejectStart(new Error('late_provider_rejection'));
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.state()).toBe('closed');
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed and ends the SDK session when no exact conversation identity is returned', async () => {
    const handle = {
      startSession: vi.fn(async () => null),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setOutputVolume: vi.fn(),
      settleToolResult: vi.fn(),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection,
      handle,
      startConfig: {},
      duckGain: 0.18,
    });

    await expect(connection.connect(new AbortController().signal)).rejects.toThrow(
      'elevenlabs_missing_conversation_id',
    );
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    expect(connection.state()).toBe('closed');
  });

});
