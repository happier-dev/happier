import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXaiNativeWebSocketDriver } from './connection.native.js';

class NativeFakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: NativeFakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: Readonly<{ headers?: Readonly<Record<string, string>> }>,
  ) {
    NativeFakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = NativeFakeWebSocket.OPEN;
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

  send(_value: string): void {}
  close(): void { this.readyState = 3; this.emit('close', { code: 1000 }); }
}

afterEach(() => {
  NativeFakeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
});

describe('xAI native WebSocket driver', () => {
  it('opens native bearer sessions with the authorization header in React Native WebSocket options', async () => {
    vi.stubGlobal('WebSocket', NativeFakeWebSocket);
    const driver = createXaiNativeWebSocketDriver({
      auth: {
        kind: 'bearer_token',
        placement: 'authorization_header',
        value: 'native-client-secret',
        expiresAtMs: Date.now() + 300_000,
      },
      model: 'grok-voice-think-fast-1.0',
      conversationId: null,
      sessionUpdate: { type: 'session.update', session: {} },
    });

    await driver.open({
      signal: new AbortController().signal,
      onControl: vi.fn(),
      onTransport: vi.fn(),
      onRemoteClose: vi.fn(),
    });

    expect(NativeFakeWebSocket.instances).toHaveLength(1);
    expect(NativeFakeWebSocket.instances[0]?.protocols).toBeUndefined();
    expect(NativeFakeWebSocket.instances[0]?.options).toEqual({
      headers: { Authorization: 'Bearer native-client-secret' },
    });
  });
});
