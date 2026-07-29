import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSession = vi.fn();

vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: (...args: unknown[]) => startSession(...args) },
}));

import { createElevenLabsConversationHandle } from './createElevenLabsConversationHandle.js';

const createHandle = () => createElevenLabsConversationHandle({
  tools: [],
});

type TestConversation = Readonly<{
  getId: () => string;
  endSession: () => Promise<void>;
  sendUserMessage: (message: string) => void;
  sendContextualUpdate: (message: string) => void;
  setMicMuted: (muted: boolean) => void;
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
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();
    const events: unknown[] = [];
    const unsubscribe = handle.subscribe((event) => events.push(event));
    await handle.startSession({ signedUrl: 'wss://example.test' });
    const callbacks = startSession.mock.calls[0]?.[0];

    callbacks.onConnect();
    callbacks.onMessage({ source: 'ai', message: 'hello' });
    callbacks.onStatusChange({ status: 'connected' });
    callbacks.onModeChange({ mode: 'speaking' });
    callbacks.onDebug('safe-debug');
    callbacks.onError('provider-error');
    callbacks.onDisconnect();

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'connect', 'message', 'status', 'mode', 'debug', 'error', 'disconnect',
    ]);
    unsubscribe();
    callbacks.onMessage({ message: 'late' });
    expect(events).toHaveLength(7);
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
    };
    const second = {
      getId: vi.fn(() => 'second'),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
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
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();

    await expect(handle.startSession({})).resolves.toBeNull();
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
  });

  it('projects outbound audio progress from the active SDK connection for liveness checks', async () => {
    const conversation = {
      getId: vi.fn(() => 'conversation-with-stats'),
      getStats: vi.fn(async () => new Map([
        ['audio', { type: 'outbound-rtp', kind: 'audio', bytesSent: 42 }],
        ['video', { type: 'outbound-rtp', kind: 'video', bytesSent: 999 }],
      ])),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
    };
    startSession.mockResolvedValue(conversation);
    const handle = createHandle();
    await handle.startSession({});

    await expect(handle.readOutboundAudioBytes()).resolves.toBe(42);
  });
});
