import { describe, expect, it, vi } from 'vitest';
import type { Callbacks } from '@elevenlabs/client';
import type { ElevenLabsConversationHandleEvent } from './createElevenLabsConversationHandle.js';

import {
  createElevenLabsSdkConnection,
  createRegisteredElevenLabsSdkConnection,
} from './elevenLabsSdkConnection.js';
import { createElevenLabsConversationHandleRegistry } from './elevenLabsConversationHandleRegistry.js';
import type { RealtimeConnection } from './types.js';

function createTestConnection(input: Readonly<{ driver: Readonly<{
  open(input: Readonly<{
    signal: AbortSignal;
    onControl: (event: unknown) => void;
    onTransport: (event: Readonly<{ type: 'session_identity'; sessionId: string }>) => void;
    onRemoteClose: (reason: string) => void;
  }>): Promise<void>;
  sendControl(event: never): Promise<void>;
  close(): Promise<void>;
}> }>): RealtimeConnection {
  let state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  let sessionId: string | null = null;
  const controls: unknown[] = [];
  const transports: unknown[] = [];
  let closePromise: Promise<void> | null = null;
  const close = async () => {
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
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      try {
        await Promise.race([input.driver.open({
          signal,
          onControl: (event) => controls.push(event),
          onTransport: (event) => { transports.push(event); sessionId = event.sessionId; },
          onRemoteClose: () => { void close(); },
        }), abort]);
        if (state === 'closed' || signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        state = 'open';
      } catch (error) {
        await close();
        throw error;
      }
    },
    sendControl: async (event) => await input.driver.sendControl(event as never),
    controlEvents: () => ({ async *[Symbol.asyncIterator]() { for (const event of controls) yield event as never; } }),
    transportEvents: () => ({ async *[Symbol.asyncIterator]() { for (const event of transports) yield event as never; } }),
    close: async () => await close(),
    state: () => state,
    currentProviderSessionId: () => sessionId,
  };
}

describe('createElevenLabsSdkConnection', () => {
  it('owns the SDK lifecycle and projects callbacks through connection channels', async () => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const handle = {
      startSession: vi.fn(async () => 'conversation-1'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      readOutboundAudioBytes: vi.fn(async () => null),
      getId: vi.fn(() => 'conversation-1'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return () => {};
      },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection: createTestConnection,
      handle,
      startConfig: { signedUrl: 'wss://example.test/session' },
    });
    const signal = new AbortController().signal;

    await connection.connect(signal);
    expect(handle.startSession).toHaveBeenCalledWith({ signedUrl: 'wss://example.test/session' });
    const providerMessage: Parameters<NonNullable<Callbacks['onMessage']>>[0] = {
      source: 'ai',
      role: 'agent',
      message: 'provider message',
    };
    publish({ type: 'message', data: providerMessage });
    publish({ type: 'mode', data: { mode: 'speaking' as never } });
    const controls = connection.controlEvents(signal)[Symbol.asyncIterator]();
    await expect(controls.next()).resolves.toEqual({
      done: false,
      value: providerMessage,
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
  });

  it('translates canonical SDK commands and turns disconnects into remote close', async () => {
    let publish!: (event: ElevenLabsConversationHandleEvent) => void;
    const dispose = vi.fn();
    const handle = {
      startSession: vi.fn(async () => 'conversation-2'),
      endSession: vi.fn(async () => {}),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      readOutboundAudioBytes: vi.fn(async () => null),
      getId: vi.fn(() => 'conversation-2'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return dispose;
      },
    };
    const connection = createElevenLabsSdkConnection({
      createSdkHandleConnection: createTestConnection,
      handle,
      startConfig: {},
    });
    await connection.connect(new AbortController().signal);

    await connection.sendControl({ type: 'voice.user_text', text: 'hello' });
    await connection.sendControl({ type: 'voice.context_update', text: 'context' });
    await connection.sendControl({ type: 'voice.input_muted', muted: true });
    expect(handle.sendUserMessage).toHaveBeenCalledWith('hello');
    expect(handle.sendContextualUpdate).toHaveBeenCalledWith('context');
    expect(handle.setMicMuted).toHaveBeenCalledWith(true);

    publish({ type: 'disconnect', reason: 'network_lost' });
    await vi.waitFor(() => expect(connection.state()).toBe('closed'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(handle.endSession).toHaveBeenCalledTimes(1);
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
      readOutboundAudioBytes: vi.fn(async () => null),
      getId: vi.fn(() => 'racing-session'),
      dispose: vi.fn(),
      subscribe: (listener: typeof publish) => {
        publish = listener;
        return () => {};
      },
    };
    const connection = createElevenLabsSdkConnection({ createSdkHandleConnection: createTestConnection, handle, startConfig: {} });

    await expect(connection.connect(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
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
      readOutboundAudioBytes: vi.fn(async () => null),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({ createSdkHandleConnection: createTestConnection, handle, startConfig: {} });
    const controller = new AbortController();
    const connecting = connection.connect(controller.signal);
    await vi.waitFor(() => expect(handle.startSession).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveStart('late-session');

    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(handle.endSession).toHaveBeenCalled();
    expect(connection.state()).toBe('closed');
  });

  it('fails closed and ends the SDK session when no exact conversation identity is returned', async () => {
    const handle = {
      startSession: vi.fn(async () => null),
      endSession: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      readOutboundAudioBytes: vi.fn(async () => null),
      getId: vi.fn(() => null),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const connection = createElevenLabsSdkConnection({ createSdkHandleConnection: createTestConnection, handle, startConfig: {} });

    await expect(connection.connect(new AbortController().signal)).rejects.toThrow(
      'elevenlabs_missing_conversation_id',
    );
    expect(handle.endSession).toHaveBeenCalledTimes(1);
    expect(connection.state()).toBe('closed');
  });

  it('waits for a late-mounted registered handle and aborts without starting when no handle arrives', async () => {
    const registry = createElevenLabsConversationHandleRegistry();
    const lateHandle = {
      startSession: vi.fn(async () => 'late-mounted'),
      endSession: vi.fn(async () => undefined),
      getId: vi.fn(() => 'late-mounted'),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
      setMicMuted: vi.fn(),
      readOutboundAudioBytes: vi.fn(async () => null),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(),
    };
    const connection = createRegisteredElevenLabsSdkConnection({ createSdkHandleConnection: createTestConnection, registry, mode: 'voice', startConfig: {} });
    const connecting = connection.connect(new AbortController().signal);
    expect(lateHandle.startSession).not.toHaveBeenCalled();
    registry.register('voice', lateHandle);
    await expect(connecting).resolves.toBeUndefined();
    expect(lateHandle.startSession).toHaveBeenCalledTimes(1);

    const emptyRegistry = createElevenLabsConversationHandleRegistry();
    const abortedConnection = createRegisteredElevenLabsSdkConnection({
      createSdkHandleConnection: createTestConnection,
      registry: emptyRegistry,
      mode: 'text',
      startConfig: {},
    });
    const controller = new AbortController();
    const abortedConnect = abortedConnection.connect(controller.signal);
    controller.abort();
    await expect(abortedConnect).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels an unresolved registry wait when the connection closes before a handle mounts', async () => {
    const registry = createElevenLabsConversationHandleRegistry();
    const connection = createRegisteredElevenLabsSdkConnection({ createSdkHandleConnection: createTestConnection, registry, mode: 'voice', startConfig: {} });
    const connecting = connection.connect(new AbortController().signal);

    await connection.close({ code: 'user_stop' });
    const settled = Promise.race([
      connecting,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('connection_wait_not_cancelled')), 25)),
    ]);
    await expect(settled).rejects.toMatchObject({ name: 'AbortError' });
  });
});
