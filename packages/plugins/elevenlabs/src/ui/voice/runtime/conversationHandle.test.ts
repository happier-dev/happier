import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSession = vi.fn();

vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: (...args: unknown[]) => startSession(...args) },
}));

import { createElevenLabsConversationHandle } from './conversationHandle.js';

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
