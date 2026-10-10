import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSession = vi.fn();

vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: (...args: unknown[]) => startSession(...args) },
}));

import { createElevenLabsConversationHandle } from './conversationHandle.js';
import { createElevenLabsSdkConnection } from './sdkConnection.js';
import { VoiceRealtimeToolCallV1Schema, type VoiceRealtimeConnection } from '@happier-dev/plugin-sdk/voice/client';

const createHandle = () => createElevenLabsConversationHandle({
  tools: [],
});

type TestConversation = Readonly<{
  getId: () => string;
  endSession: () => Promise<void>;
  sendUserMessage: (message: string) => void;
  sendContextualUpdate: (message: string) => void;
  setMicMuted: (muted: boolean) => void;
  setVolume: (input: Readonly<{ volume: number }>) => void;
}>;

describe('createElevenLabsConversationHandle event surface', () => {
  beforeEach(() => startSession.mockReset());

  it('publishes typed provider events to current subscribers and unsubscribe is terminal', async () => {
    const conversation = {
      getId: vi.fn(() => 'conversation-1'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();
    const events: unknown[] = [];
    const unsubscribe = handle.subscribe((event) => events.push(event));
    await handle.startSession({ signedUrl: 'wss://example.test' });
    const callbacks = startSession.mock.calls[0]?.[0];

    callbacks.onConnect();
    callbacks.onMessage({ source: 'ai', message: 'hello' });
    // A corrected agent turn arrives on its own SDK callback, never as a second
    // `onMessage`, so the handle has to carry it or the correction is lost.
    callbacks.onAgentResponseCorrection({
      original_agent_response: 'hello',
      corrected_agent_response: 'hello there',
      event_id: 3,
    });
    callbacks.onStatusChange({ status: 'connected' });
    callbacks.onModeChange({ mode: 'speaking' });
    callbacks.onDebug('safe-debug');
    callbacks.onError('provider-error');
    callbacks.onDisconnect();

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'connect', 'message', 'agent_response_correction', 'status', 'mode', 'debug', 'error', 'disconnect',
    ]);
    expect(events[2]).toEqual({
      type: 'agent_response_correction',
      data: {
        original_agent_response: 'hello',
        corrected_agent_response: 'hello there',
        event_id: 3,
      },
    });
    unsubscribe();
    callbacks.onMessage({ message: 'late' });
    expect(events).toHaveLength(8);
  });

  it('does not start after disposal and notifies active subscribers of handle teardown once', async () => {
    const handle = createHandle();
    const events: unknown[] = [];
    handle.subscribe((event) => events.push(event));

    handle.dispose();
    await expect(handle.startSession({})).resolves.toBeNull();
    expect(startSession).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'disconnect', reason: 'handle_disposed' }]);
    handle.dispose();
    expect(events).toHaveLength(1);
  });

  it('preserves SDK tool-error context and suppresses errors from a retired start', async () => {
    startSession.mockResolvedValue({ getId: () => 'errors', endSession: async () => {} });
    const handle = createHandle();
    const events: unknown[] = [];
    handle.subscribe((event) => events.push(event));
    await handle.startSession({});
    const callbacks = startSession.mock.calls[0]![0];
    callbacks.onError('tool failed', { clientToolName: 'readSession' });
    expect(events).toEqual([{
      type: 'error', error: 'tool failed', context: { clientToolName: 'readSession' },
    }]);
    await handle.endSession();
    callbacks.onError('late terminal failure');
    expect(events).toHaveLength(1);
  });

  it('returns real SDK tool errors without closing and accepts the following user turn', async () => {
    const { TextConversation } = await vi.importActual<typeof import('@elevenlabs/client')>('@elevenlabs/client');
    let incoming!: (event: unknown) => Promise<void>;
    const sent: unknown[] = [];
    const close = vi.fn();
    const network = {
      conversationId: 'real-sdk-tool-error',
      onMessage(callback: typeof incoming) { incoming = callback; },
      onDisconnect() {}, onModeChange() {}, onOutgoingMessage() {},
      sendMessage(event: unknown) { sent.push(event); }, close,
    };
    // Replace only network startup. The installed SDK's constructor, public
    // callback dispatch, tool-error handling and result encoding remain real.
    startSession.mockImplementation(async (options) => Reflect.construct(TextConversation, [options, network]));
    const tools = [{
      name: 'unavailableRead', execute: async () => { throw new Error('voice_action_unavailable'); },
    }];
    const handle = createElevenLabsConversationHandle({ tools });
    let driver!: Parameters<Parameters<typeof createElevenLabsSdkConnection>[0]['createSdkHandleConnection']>[0]['driver'];
    const remoteClose = vi.fn();
    createElevenLabsSdkConnection({
      handle, startConfig: { textOnly: true }, duckGain: 0.18,
      createSdkHandleConnection(input) { driver = input.driver; return {} as VoiceRealtimeConnection; },
    });
    await driver.open({
      signal: new AbortController().signal,
      onControl(event) {
        const envelope = event as Readonly<{ type?: unknown; call?: unknown }>;
        if (envelope.type !== 'elevenlabs.client_tool_call') return;
        const call = VoiceRealtimeToolCallV1Schema.parse(envelope.call);
        void driver.sendControl({ type: 'voice.tool_result', result: {
          v: 1, responseId: call.responseId, callId: call.callId,
          toolName: call.toolName, order: call.order, status: 'denied', errorCode: 'voice_action_unavailable',
        } });
      }, onTransport() {},
      onRemoteClose(reason) { remoteClose(reason); void driver.close(); },
    });
    await incoming({ type: 'client_tool_call', client_tool_call: {
      tool_call_id: 'provider-failed-read', tool_name: 'unavailableRead', parameters: {},
    } });
    expect(sent).toEqual([expect.objectContaining({
      type: 'client_tool_result', tool_call_id: 'provider-failed-read', is_error: true,
    })]);
    expect(remoteClose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await driver.sendControl({ type: 'voice.user_text', text: 'continue after refusal' });
    expect(sent[1]).toEqual({ type: 'user_message', text: 'continue after refusal' });
    await driver.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('requires actual provider custody, settles matching deliveries individually and revokes late callbacks', async () => {
    startSession.mockResolvedValue({ getId: () => 'custody', endSession: async () => {} });
    const execute = vi.fn(async () => ({ unsafe: true }));
    const tools = [{ name: 'effect', execute }];
    const handle = createElevenLabsConversationHandle({ tools });
    const events: unknown[] = [];
    handle.subscribe((event) => events.push(event));
    await handle.startSession({});
    const options = startSession.mock.calls[0]![0];
    const parameters = { message: 'first' };
    options.onIncomingEvent?.({ type: 'client_tool_call', client_tool_call: {
      tool_call_id: 'provider-call', tool_name: 'effect', parameters,
    } });
    const delivery = options.clientTools.effect(parameters);
    const call = { v: 1, responseId: 'provider-call', callId: 'provider-call', toolName: 'effect', order: 0, arguments: parameters };
    const resultIdentity = { v: 1 as const, responseId: call.responseId, callId: call.callId, toolName: call.toolName, order: call.order };
    expect(events).toEqual([{ type: 'tool_call', call }]);
    expect(execute).not.toHaveBeenCalled();
    handle.settleToolResult({ ...resultIdentity, status: 'success', output: { allowed: true } });
    await expect(delivery).resolves.toEqual({ allowed: true });
    await expect(options.clientTools.effect({})).rejects.toThrow('voice_effect_call_custody_unavailable');
    const pendingParameters = { message: 'pending' };
    options.onIncomingEvent?.({ type: 'client_tool_call', client_tool_call: {
      tool_call_id: 'pending-call', tool_name: 'effect', parameters: pendingParameters,
    } });
    const pending = options.clientTools.effect(pendingParameters);
    const cancelled = expect(pending).rejects.toThrow('tool_cancelled');
    await handle.endSession();
    await cancelled;
    await expect(options.clientTools.effect(parameters)).rejects.toThrow('tool_cancelled');
    expect(events).toHaveLength(2);
    await handle.startSession({});
    const replacement = startSession.mock.calls[1]![0];
    const replacementParameters = { message: 'replacement' };
    replacement.onIncomingEvent?.({ type: 'client_tool_call', client_tool_call: {
      tool_call_id: 'provider-call', tool_name: 'effect', parameters: replacementParameters,
    } });
    const replacementDelivery = replacement.clientTools.effect(replacementParameters);
    await expect(options.clientTools.effect(replacementParameters)).rejects.toThrow('tool_cancelled');
    handle.settleToolResult({ ...resultIdentity, status: 'success', output: { replacement: true } });
    await expect(replacementDelivery).resolves.toEqual({ replacement: true });
    expect(events).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
    await handle.endSession();
  });

  it('retains a focus volume until a late SDK conversation becomes active', async () => {
    const conversation = {
      getId: vi.fn(() => 'conversation-focus'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();

    handle.setOutputVolume(0);
    await expect(handle.startSession({})).resolves.toBe('conversation-focus');
    expect(conversation.setVolume).toHaveBeenCalledWith({ volume: 0 });

    handle.setOutputVolume(0.18);
    expect(conversation.setVolume).toHaveBeenLastCalledWith({ volume: 0.18 });
  });

  it('applies the latest microphone mute before a late SDK conversation becomes active', async () => {
    let resolveStart!: (conversation: TestConversation) => void;
    const pendingStart = new Promise<TestConversation>((resolve) => { resolveStart = resolve; });
    const conversation = {
      getId: vi.fn(() => 'conversation-muted'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockImplementationOnce(async () => await pendingStart);
    const handle = createHandle();

    const started = handle.startSession({});
    handle.setMicMuted(true);
    resolveStart(conversation);

    await expect(started).resolves.toBe('conversation-muted');
    expect(conversation.setMicMuted).toHaveBeenCalledTimes(1);
    expect(conversation.setMicMuted).toHaveBeenCalledWith(true);
    expect(handle.getId()).toBe('conversation-muted');
  });

  it('ends a superseded late SDK conversation and suppresses all callbacks from the stale start', async () => {
    let resolveFirst!: (conversation: TestConversation) => void;
    let resolveSecond!: (conversation: TestConversation) => void;
    const firstStart = new Promise<TestConversation>((resolve) => { resolveFirst = resolve; });
    const secondStart = new Promise<TestConversation>((resolve) => { resolveSecond = resolve; });
    const first = {
      getId: vi.fn(() => 'first'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    const second = {
      getId: vi.fn(() => 'second'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockImplementationOnce(async () => await firstStart).mockImplementationOnce(async () => await secondStart);
    const handle = createHandle();
    const events: unknown[] = [];
    handle.subscribe((event) => events.push(event));
    const oldStart = handle.startSession({ id: 'old' });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const newStart = handle.startSession({ id: 'new' });

    resolveSecond(second);
    await expect(newStart).resolves.toBe('second');
    resolveFirst(first);
    await expect(oldStart).resolves.toBeNull();
    expect(first.endSession).toHaveBeenCalledTimes(1);

    startSession.mock.calls[0]?.[0]?.onMessage?.({ message: 'stale' });
    startSession.mock.calls[1]?.[0]?.onMessage?.({ message: 'current' });
    expect(events).toEqual([{ type: 'message', data: { message: 'current' } }]);
  });

  it('ends an in-flight conversation that resolves after handle disposal', async () => {
    let resolveStart!: (conversation: TestConversation) => void;
    const pendingStart = new Promise<TestConversation>((resolve) => { resolveStart = resolve; });
    const conversation = {
      getId: vi.fn(() => 'late'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockImplementationOnce(async () => await pendingStart);
    const handle = createHandle();
    const started = handle.startSession({});
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    handle.dispose();
    resolveStart(conversation);

    await expect(started).resolves.toBeNull();
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    expect(handle.getId()).toBeNull();
  });

  it('ends a provider conversation rather than normalizing an inexact opaque identity', async () => {
    const conversation = {
      getId: vi.fn(() => ' conversation-with-padding '),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      setVolume: vi.fn(),
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();

    await expect(handle.startSession({})).resolves.toBeNull();
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
  });

});
