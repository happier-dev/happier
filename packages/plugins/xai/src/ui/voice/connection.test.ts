import { describe, expect, it, vi } from 'vitest';

import { createXaiWebSocketDriver } from './connection.js';

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(readonly url: string, readonly protocols?: string | string[]) {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: unknown = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close', { code: 1000, reason: '' }); }
}

function jsonEventWithExactUtf8Bytes(totalBytes: number): string {
  const values = ['', '', '', '', '', '', '', ''];
  let remaining = totalBytes
    - new TextEncoder().encode(JSON.stringify({ type: 'fixture', values })).byteLength;
  if (remaining < 0) throw new Error('fixture_too_small');
  for (let index = 0; index < values.length; index += 1) {
    const bytes = Math.min(64 * 1024, remaining);
    values[index] = `${'é'.repeat(Math.floor(bytes / 2))}${bytes % 2 === 0 ? '' : 'x'}`;
    remaining -= bytes;
  }
  if (remaining !== 0) throw new Error('fixture_too_large');
  const serialized = JSON.stringify({ type: 'fixture', values });
  if (new TextEncoder().encode(serialized).byteLength !== totalBytes) {
    throw new Error('fixture_byte_length_mismatch');
  }
  return serialized;
}

describe('xAI WebSocket driver', () => {
  it('settles an in-flight open when the connection is closed before WebSocket open', async () => {
    const socket = new FakeWebSocket('');
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: null, sessionUpdate: { type: 'session.update', session: {} },
      createWebSocket: () => socket,
    });
    const opening = driver.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose: vi.fn() });
    await driver.close({ code: 'replaced' });
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the official endpoint, model query, browser subprotocol and nested session update', async () => {
    let socket!: FakeWebSocket;
    const createWebSocket = vi.fn((url: string, protocols?: string | string[]) => {
      socket = new FakeWebSocket(url, protocols);
      queueMicrotask(() => { socket.readyState = FakeWebSocket.OPEN; socket.emit('open'); });
      return socket;
    });
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: 'conv old/id', sessionUpdate: { type: 'session.update', session: { voice: 'eve' } },
      createWebSocket,
    });
    await driver.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose: vi.fn() });
    expect(socket.url).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0&conversation_id=conv+old%2Fid');
    expect(socket.protocols).toEqual(['xai-client-secret.short']);
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: 'session.update', session: { voice: 'eve' } }]);
  });

  it('maps conversation identity/audio, bounds backpressure and removes listeners on close', async () => {
    let socket!: FakeWebSocket;
    const createWebSocket = (url: string, protocols?: string | string[]) => {
      socket = new FakeWebSocket(url, protocols);
      queueMicrotask(() => { socket.readyState = FakeWebSocket.OPEN; socket.emit('open'); });
      return socket;
    };
    const onTransport = vi.fn(); const onControl = vi.fn(); const onAudioDelta = vi.fn(); const onRemoteClose = vi.fn();
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: null, sessionUpdate: { type: 'session.update', session: {} },
      createWebSocket, onAudioDelta, maxBufferedAmountBytes: 16,
    });
    await driver.open({ signal: new AbortController().signal, onControl, onTransport, onRemoteClose });
    socket.emit('message', { data: JSON.stringify({ type: 'conversation.created', conversation: { id: 'conv1' } }) });
    socket.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
    expect(onTransport).toHaveBeenCalledWith({ type: 'session_identity', sessionId: 'conv1' });
    expect(onAudioDelta).toHaveBeenCalledWith('AA==');
    socket.bufferedAmount = 17;
    expect(() => driver.sendAudioChunk('AQI=')).toThrow(expect.objectContaining({ code: 'voice_connection_backpressure' }));
    socket.emit('error');
    expect(onRemoteClose).toHaveBeenCalledWith('xai_websocket_error');
    await driver.close({ code: 'user_stop' });
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('enforces the measured inbound UTF-8 byte cap before parsing xAI controls', async () => {
    const socket = new FakeWebSocket('');
    const onControl = vi.fn();
    const onRemoteClose = vi.fn();
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: null, sessionUpdate: { type: 'session.update', session: {} },
      createWebSocket: () => {
        queueMicrotask(() => { socket.readyState = FakeWebSocket.OPEN; socket.emit('open'); });
        return socket;
      },
    });
    await driver.open({ signal: new AbortController().signal, onControl, onTransport: vi.fn(), onRemoteClose });

    const inboundControlBytes = 512 * 1024;
    const exact = jsonEventWithExactUtf8Bytes(inboundControlBytes);
    expect(exact.length).toBeLessThan(inboundControlBytes);
    socket.emit('message', { data: exact });
    expect(onControl).toHaveBeenCalledTimes(1);

    const oversized = jsonEventWithExactUtf8Bytes(inboundControlBytes + 1);
    expect(oversized.length).toBeLessThan(inboundControlBytes);
    socket.emit('message', { data: oversized });
    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onRemoteClose).toHaveBeenCalledWith('xai_control_oversized');
  });

  it('turns malformed provider audio into a connection failure instead of throwing from the event listener', async () => {
    const socket = new FakeWebSocket('');
    const onRemoteClose = vi.fn();
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: null, sessionUpdate: { type: 'session.update', session: {} },
      createWebSocket: () => {
        queueMicrotask(() => { socket.readyState = FakeWebSocket.OPEN; socket.emit('open'); });
        return socket;
      },
      onAudioDelta: () => { throw new Error('invalid_pcm'); },
    });
    await driver.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose });
    expect(() => socket.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad' }) })).not.toThrow();
    expect(onRemoteClose).toHaveBeenCalledWith('xai_output_audio_invalid');
  });

  it('fails the connection when canonical playback rejects an output chunk for backpressure', async () => {
    const socket = new FakeWebSocket('');
    const onRemoteClose = vi.fn();
    const driver = createXaiWebSocketDriver({
      auth: { kind: 'subprotocol_token', placement: 'websocket_subprotocol', value: 'xai-client-secret.short', expiresAtMs: Date.now() + 300_000 },
      model: 'grok-voice-think-fast-1.0', conversationId: null, sessionUpdate: { type: 'session.update', session: {} },
      createWebSocket: () => {
        queueMicrotask(() => { socket.readyState = FakeWebSocket.OPEN; socket.emit('open'); });
        return socket;
      },
      onAudioDelta: () => false,
    });
    await driver.open({ signal: new AbortController().signal, onControl: vi.fn(), onTransport: vi.fn(), onRemoteClose });
    socket.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
    expect(onRemoteClose).toHaveBeenCalledWith('xai_output_audio_backpressure');
  });
});
