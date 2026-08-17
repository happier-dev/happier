import type {
  VoiceClientAuthArtifact } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice';

type CloseReason = Readonly<{ code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error'; detail?: string }>;
type TransportEvent = Readonly<{ type: 'session_identity'; sessionId: string }>;
type OpenInput = Readonly<{
  signal: AbortSignal;
  onControl: (event: unknown) => void;
  onTransport: (event: TransportEvent) => void;
  onRemoteClose: (reason: string) => void;
}>;

export type XaiWebSocketLike = Readonly<{
  readyState: number;
  bufferedAmount: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}>;

export type CreateXaiWebSocket = (
  url: string,
  protocols?: string | string[],
  headers?: Readonly<Record<string, string>>,
) => XaiWebSocketLike;

// xAI shares the canonical Voice JSON event envelope. Its worst-case currently
// admitted final is 394,440 UTF-8 bytes; 512 KiB leaves 129,848 bytes for the
// provider envelope while staying aligned with the one host control budget.
const XAI_INBOUND_CONTROL_MAX_BYTES = 512 * 1024;

function providerError(code: 'provider_response_invalid' | 'voice_connection_backpressure' | 'voice_connection_not_open'): Error {
  return Object.assign(new Error(code), { code });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function defaultCreateWebSocket(url: string, protocols?: string | string[]): XaiWebSocketLike {
  if (typeof WebSocket !== 'function') throw providerError('provider_response_invalid');
  return new WebSocket(url, protocols);
}

export type XaiWebSocketDriverInput = Readonly<{
  auth: VoiceClientAuthArtifact;
  model: string;
  conversationId: string | null;
  sessionUpdate: VoiceRealtimeJsonValue;
  createWebSocket?: CreateXaiWebSocket;
  endpoint?: string;
  onAudioDelta?: (base64Pcm16: string) => boolean;
  onOutputDone?: () => void;
  onConversationId?: (conversationId: string) => void | Promise<void>;
  maxBufferedAmountBytes?: number;
  maxEarlyAudioBytes?: number;
}>;

export function createXaiWebSocketDriver(input: XaiWebSocketDriverInput) {
  const createWebSocket = input.createWebSocket ?? defaultCreateWebSocket;
  const maxBufferedAmountBytes = input.maxBufferedAmountBytes ?? 512 * 1024;
  const maxEarlyAudioBytes = input.maxEarlyAudioBytes ?? 256 * 1024;
  const textEncoder = new TextEncoder();
  let socket: XaiWebSocketLike | null = null;
  let opened = false;
  let closing = false;
  let openInput: OpenInput | null = null;
  let cancelPendingOpen: (() => void) | null = null;
  let earlyAudioBytes = 0;
  const earlyAudio: string[] = [];
  const listeners: Array<() => void> = [];

  const listen = (target: XaiWebSocketLike, type: string, listener: (event: unknown) => void): void => {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  };
  const sendJson = (value: VoiceRealtimeJsonValue): void => {
    if (!socket || socket.readyState !== 1) throw providerError('voice_connection_not_open');
    if (socket.bufferedAmount > maxBufferedAmountBytes) throw providerError('voice_connection_backpressure');
    socket.send(JSON.stringify(value));
  };
  const flushEarlyAudio = (): void => {
    while (earlyAudio.length > 0) sendJson({ type: 'input_audio_buffer.append', audio: earlyAudio.shift()! });
    earlyAudioBytes = 0;
  };

  return Object.freeze({
    async open(handlers: OpenInput): Promise<void> {
      if (socket) throw new Error('voice_connection_already_started');
      if (handlers.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      openInput = handlers;
      const url = new URL(input.endpoint ?? 'wss://api.x.ai/v1/realtime');
      url.searchParams.set('model', input.model);
      if (input.conversationId) url.searchParams.set('conversation_id', input.conversationId);
      const protocols = input.auth.kind === 'subprotocol_token' && input.auth.placement === 'websocket_subprotocol'
        ? [input.auth.value]
        : undefined;
      const headers = input.auth.kind === 'bearer_token' && input.auth.placement === 'authorization_header'
        ? { Authorization: `Bearer ${input.auth.value}` }
        : undefined;
      if (!protocols && !headers) throw providerError('provider_response_invalid');
      const ws = createWebSocket(url.toString(), protocols, headers);
      socket = ws;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (operation: () => void) => {
          if (settled) return;
          settled = true;
          cancelPendingOpen = null;
          handlers.signal.removeEventListener('abort', aborted);
          operation();
        };
        const aborted = () => settle(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        cancelPendingOpen = aborted;
        handlers.signal.addEventListener('abort', aborted, { once: true });
        listen(ws, 'open', () => settle(() => {
          try {
            opened = true;
            sendJson(input.sessionUpdate);
            flushEarlyAudio();
            resolve();
          } catch (error) { reject(error); }
        }));
        listen(ws, 'error', () => {
          if (opened) {
            if (!closing) handlers.onRemoteClose('xai_websocket_error');
            return;
          }
          settle(() => reject(providerError('provider_response_invalid')));
        });
        listen(ws, 'close', (raw) => {
          const event = record(raw);
          settle(() => reject(providerError('provider_response_invalid')));
          if (!closing) handlers.onRemoteClose(`xai_websocket_closed:${String(event?.code ?? 'unknown')}`);
        });
        listen(ws, 'message', (raw) => {
          const data = record(raw)?.data;
          if (typeof data !== 'string') return;
          if (textEncoder.encode(data).byteLength > XAI_INBOUND_CONTROL_MAX_BYTES) {
            if (!closing) handlers.onRemoteClose('xai_control_oversized');
            return;
          }
          let event: unknown;
          try { event = JSON.parse(data); } catch { return; }
          const parsed = record(event);
          if (!parsed || typeof parsed.type !== 'string') return;
          handlers.onControl(event);
          if (parsed.type === 'conversation.created') {
            const conversationId = record(parsed.conversation)?.id;
            if (typeof conversationId === 'string' && conversationId.trim()) {
              const persisted = input.onConversationId?.(conversationId);
              if (persisted && typeof persisted.then === 'function') {
                void persisted.catch(() => {
                  if (!closing) handlers.onRemoteClose('xai_resumption_state_write_failed');
                });
              }
              handlers.onTransport({ type: 'session_identity', sessionId: conversationId });
            }
          }
          if (parsed.type === 'response.output_audio.delta' && typeof parsed.delta === 'string') {
            try {
              if (input.onAudioDelta?.(parsed.delta) === false && !closing) {
                handlers.onRemoteClose('xai_output_audio_backpressure');
              }
            } catch {
              if (!closing) handlers.onRemoteClose('xai_output_audio_invalid');
            }
          }
          if (parsed.type === 'response.output_audio.done') input.onOutputDone?.();
        });
      });
    },
    async sendControl(event: VoiceRealtimeJsonValue): Promise<void> { sendJson(event); },
    sendAudioChunk(base64Pcm16: string): void {
      if (!base64Pcm16) return;
      if (opened) { sendJson({ type: 'input_audio_buffer.append', audio: base64Pcm16 }); return; }
      const bytes = Math.ceil(base64Pcm16.length * 0.75);
      if (earlyAudioBytes + bytes > maxEarlyAudioBytes) throw providerError('voice_connection_backpressure');
      earlyAudio.push(base64Pcm16);
      earlyAudioBytes += bytes;
    },
    async close(_reason: CloseReason): Promise<void> {
      if (closing) return;
      closing = true;
      opened = false;
      earlyAudio.length = 0;
      earlyAudioBytes = 0;
      cancelPendingOpen?.();
      cancelPendingOpen = null;
      while (listeners.length > 0) listeners.pop()?.();
      const active = socket;
      socket = null;
      openInput = null;
      if (active && active.readyState !== 3) active.close(1000, 'voice_session_ended');
    },
  });
}
