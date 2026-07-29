import { describe, expect, it, vi } from 'vitest';
import type { PluginVoiceRealtimeConnection } from '@happier-dev/plugin-sdk/runtime';

import {
  activate,
  createElevenLabsVoiceProviderRuntimeRegistration,
} from './createRuntimeContribution.js';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../protocol/voice/index.js';

const sdk = vi.hoisted(() => ({
  startSession: vi.fn(),
  endSession: vi.fn(async () => undefined),
  setMicMuted: vi.fn(),
  sendUserMessage: vi.fn(),
  sendContextualUpdate: vi.fn(),
  getId: vi.fn(() => 'conversation-1'),
}));

vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: sdk.startSession },
}));

function createSdkHandleConnection(input: Readonly<{ driver: Readonly<{
  open(input: Readonly<{
    signal: AbortSignal;
    onControl(event: unknown): void;
    onTransport(event: Readonly<{ type: 'session_identity'; sessionId: string }>): void;
    onRemoteClose(reason: string): void;
  }>): Promise<void>;
  sendControl(event: never): Promise<void>;
  close(): Promise<void>;
}> }>, observations?: Readonly<{
  onControl?(event: unknown): void;
  onTransport?(event: Readonly<{ type: 'session_identity'; sessionId: string }>): void;
}>): PluginVoiceRealtimeConnection {
  let state: ReturnType<PluginVoiceRealtimeConnection['state']> = 'idle';
  let providerSessionId: string | null = null;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (!closePromise) {
      state = 'closed';
      closePromise = input.driver.close();
    }
    await closePromise;
  };
  return {
    kind: 'sdk_handle',
    async connect(signal) {
      state = 'connecting';
      const abort = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      try {
        await Promise.race([
          input.driver.open({
            signal,
            onControl(event) { observations?.onControl?.(event); },
            onTransport(event) {
              providerSessionId = event.sessionId;
              observations?.onTransport?.(event);
            },
            onRemoteClose() { void close(); },
          }),
          abort,
        ]);
        if (state === 'closed' || signal.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        state = 'open';
      } catch (error) {
        await close();
        throw error;
      }
    },
    sendControl: async (event) => await input.driver.sendControl(event as never),
    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    async close() { await close(); },
    state: () => state,
    currentProviderSessionId: () => providerSessionId,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate() {},
  };
}

describe('ElevenLabs public Voice provider leaf', () => {
  it('registers the manifest-local id through a normal host-free activate(api) entry', () => {
    const register = vi.fn();
    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledWith('realtime-elevenlabs', expect.any(Object));
    const runtime = register.mock.calls[0]![1] as Record<string, unknown>;
    expect(runtime).toMatchObject({ requiresMicForConnection: false, outputLevelMeter: 'unavailable' });
    expect(runtime).not.toHaveProperty('start');
    expect(runtime).not.toHaveProperty('stop');
    expect(runtime).not.toHaveProperty('getSnapshot');
    expect((runtime.protocol as Readonly<{ encodeTurnControl(action: string): unknown }>).encodeTurnControl('cancel_response')).toBeNull();
  });

  it('keeps auth bounded, delegates SDK media, and closes hosted bookkeeping with the connection', async () => {
    sdk.startSession.mockResolvedValueOnce({
      endSession: sdk.endSession,
      setMicMuted: sdk.setMicMuted,
      sendUserMessage: sdk.sendUserMessage,
      sendContextualUpdate: sdk.sendContextualUpdate,
      getId: sdk.getId,
    });
    const runtime = createElevenLabsVoiceProviderRuntimeRegistration();
    const signal = new AbortController().signal;
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-1', attemptId: 1, reason: 'initial', request: {},
      platform: 'web', providerConfig: {
        mode: 'default',
        billingMode: 'byo',
        byo: { agentId: 'agent-1' },
        tts: {
          voiceId: 'EST9Ui6982FZPSi7gCHi',
          modelId: null,
          voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
          },
        },
      },
      accountOperations: {
        request: vi.fn(async () => ({
          status: 200,
          finalUrl: 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent-1',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ token: 'short-lived-token' })),
        })),
      },
      providerConversation: null,
      hostedConversation: null,
      signal,
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    expect(prepared.session.safeMetadata).not.toHaveProperty('token');

    const publicSdkHandleConnection = vi.fn(createSdkHandleConnection);
    const connection = await runtime.createConnection({
      session: prepared.session,
      attemptId: 1,
      mic: {
        ensureActive: vi.fn(async () => undefined), teardown: vi.fn(async () => undefined),
        setMuted: vi.fn(), isMuted: vi.fn(() => true), getStream: vi.fn(() => null),
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: {
        createSdkHandleConnection: publicSdkHandleConnection,
        createWebRtcConnection: vi.fn(),
        createPcmConnection: vi.fn(),
      },
      tools: [{
        name: 'readSession',
        description: 'Read session state',
        parameters: { type: 'object', additionalProperties: false },
        execute: vi.fn(async () => ({ status: 'ok', path: '[redacted]' })),
      }] as never,
      ui: {} as never,
      signal,
      execution: { kind: 'direct_media' },
    });
    expect(publicSdkHandleConnection).toHaveBeenCalledTimes(1);
    await connection.connect(new AbortController().signal);
    const startOptions = sdk.startSession.mock.calls[0]?.[0] as Readonly<{
      clientTools?: Readonly<Record<string, (parameters: unknown) => Promise<unknown>>>;
    }>;
    expect(await startOptions.clientTools?.readSession?.({})).toEqual({
      status: 'ok',
      path: '[redacted]',
    });
    expect(sdk.setMicMuted).toHaveBeenCalledWith(true);
    await runtime.setInputMuted?.(false);
    expect(sdk.setMicMuted).toHaveBeenLastCalledWith(false);
    await connection.close({ code: 'user_stop' });
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
    await runtime.dispose?.();
  });

  it('aborts hosted bookkeeping and suppresses late SDK publication after End Voice', async () => {
    let resolveSdkStart!: (conversation: Readonly<{
      endSession: () => Promise<void>;
      setMicMuted: (muted: boolean) => void;
      sendUserMessage: (message: string) => void;
      sendContextualUpdate: (update: string) => void;
      getId: () => string;
    }>) => void;
    const pendingSdkStart = new Promise<Parameters<typeof resolveSdkStart>[0]>((resolve) => {
      resolveSdkStart = resolve;
    });
    sdk.startSession.mockImplementationOnce(async () => await pendingSdkStart);
    const lateConversation = {
      endSession: vi.fn(async () => undefined),
      setMicMuted: vi.fn(),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      getId: vi.fn(() => 'late-conversation'),
    };
    const hostedConversation = {
      start: vi.fn(async () => ({
        allowed: true as const,
        token: 'hosted-token',
        leaseId: 'lease-late',
        bindingNonce: 'nonce-late',
        expiresAtMs: Date.now() + 60_000,
      })),
      complete: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const runtime = createElevenLabsVoiceProviderRuntimeRegistration();
    const attempt = new AbortController();
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'control-late',
      attemptId: 2,
      reason: 'initial',
      request: {},
      platform: 'web',
      providerConfig: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'happier',
      },
      accountOperations: { request: vi.fn() },
      providerConversation: null,
      hostedConversation,
      signal: attempt.signal,
    });
    if (prepared.kind !== 'prepared') throw new Error('expected_prepared');
    const controls: unknown[] = [];
    const identities: unknown[] = [];
    const connection = await runtime.createConnection({
      session: prepared.session,
      attemptId: 2,
      mic: {
        ensureActive: vi.fn(async () => undefined),
        teardown: vi.fn(async () => undefined),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        getStream: vi.fn(() => null),
      },
      interruption: { duckGain: 0.18, retainedOutputMaxMs: 1_500 },
      levels: { onOutputLevel: vi.fn() },
      media: {
        createSdkHandleConnection: (input) => createSdkHandleConnection(input, {
          onControl: (event) => controls.push(event),
          onTransport: (event) => identities.push(event),
        }),
        createWebRtcConnection: vi.fn(),
        createPcmConnection: vi.fn(),
      },
      tools: [],
      ui: {} as never,
      signal: attempt.signal,
      execution: { kind: 'direct_media' },
    });
    const startCallsBeforeConnect = sdk.startSession.mock.calls.length;
    const connecting = connection.connect(attempt.signal);
    await vi.waitFor(() => {
      expect(sdk.startSession).toHaveBeenCalledTimes(startCallsBeforeConnect + 1);
    });
    const sdkOptions = sdk.startSession.mock.calls.at(-1)?.[0] as Readonly<{
      onConnect(): void;
      onMessage(value: unknown): void;
      onModeChange(value: unknown): void;
    }>;

    attempt.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.state()).toBe('closed');

    sdkOptions.onConnect();
    sdkOptions.onMessage({ source: 'ai', message: 'late transcript' });
    sdkOptions.onModeChange({ mode: 'speaking' });
    resolveSdkStart(lateConversation);
    await vi.waitFor(() => expect(lateConversation.endSession).toHaveBeenCalledTimes(1));

    expect(controls).toEqual([]);
    expect(identities).toEqual([]);
    expect(hostedConversation.complete).not.toHaveBeenCalled();
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
    expect(lateConversation.setMicMuted).not.toHaveBeenCalled();
    await runtime.dispose?.();
    expect(lateConversation.endSession).toHaveBeenCalledTimes(1);
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
  });
});
