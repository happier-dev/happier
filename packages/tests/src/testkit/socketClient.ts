import { io, type Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

export type UpdateEvent = {
  id?: string;
  seq?: number;
  createdAt?: number;
  body?: { t?: string; [k: string]: unknown };
  [k: string]: unknown;
};
export type EphemeralEvent = { type?: string; [k: string]: unknown };
type RpcRequestPayload = { method: string; params: string };
type RpcRegisterEventPayload = { method?: unknown; error?: unknown };
type RpcResponseEnvelope = { ok?: unknown; result?: unknown; error?: unknown; errorCode?: unknown };

export type CapturedEvent =
  | { at: number; kind: 'update'; payload: UpdateEvent }
  | { at: number; kind: 'ephemeral'; payload: EphemeralEvent }
  | { at: number; kind: 'connect' }
  | { at: number; kind: 'disconnect'; reason?: string }
  | { at: number; kind: 'connect_error'; message: string };

export class SocketCollector {
  private readonly socket: Socket;
  private readonly events: CapturedEvent[] = [];

  constructor(socket: Socket) {
    this.socket = socket;

    socket.on('connect', () => this.events.push({ at: Date.now(), kind: 'connect' }));
    socket.on('disconnect', (reason) => this.events.push({ at: Date.now(), kind: 'disconnect', reason }));
    socket.on('connect_error', (err: unknown) => this.events.push({ at: Date.now(), kind: 'connect_error', message: describeError(err) }));
    socket.on('update', (payload: unknown) => this.events.push({ at: Date.now(), kind: 'update', payload: (payload ?? {}) as UpdateEvent }));
    socket.on('ephemeral', (payload: unknown) =>
      this.events.push({ at: Date.now(), kind: 'ephemeral', payload: (payload ?? {}) as EphemeralEvent }),
    );
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  close(): void {
    this.socket.close();
  }

  isConnected(): boolean {
    return this.socket.connected;
  }

  getEvents(): CapturedEvent[] {
    return [...this.events];
  }

  async emitWithAck<T = unknown>(event: string, data: unknown, timeoutMs = 10_000): Promise<T> {
    return (await this.socket.timeout(timeoutMs).emitWithAck(event as any, data)) as T;
  }

  onRpcRequest(handler: (data: RpcRequestPayload) => string | Promise<string>): () => void {
    const listener = async (data: RpcRequestPayload, callback: (response: string) => void) => {
      try {
        const out = await handler(data);
        callback(out);
      } catch (e: unknown) {
        callback(JSON.stringify({ ok: false, error: describeError(e) }));
      }
    };
    this.socket.on(SOCKET_RPC_EVENTS.REQUEST as any, listener as any);
    return () => {
      this.socket.off(SOCKET_RPC_EVENTS.REQUEST as any, listener as any);
    };
  }

  async rpcRegister(method: string): Promise<void> {
    const timeoutMs = 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rpc-register timed out for method: ${method}`));
      }, timeoutMs);

      const onRegistered = (data: RpcRegisterEventPayload) => {
        if (data?.method !== method) return;
        cleanup();
        resolve();
      };

      const onError = (data: RpcRegisterEventPayload) => {
        const errorMethod = typeof data?.method === 'string' ? data.method : null;
        if (errorMethod && errorMethod !== method) return;
        cleanup();
        reject(new Error(`rpc-register error: ${typeof data?.error === 'string' ? data.error : 'unknown'}`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off(SOCKET_RPC_EVENTS.REGISTERED as any, onRegistered as any);
        this.socket.off(SOCKET_RPC_EVENTS.ERROR as any, onError as any);
      };

      this.socket.on(SOCKET_RPC_EVENTS.REGISTERED as any, onRegistered as any);
      this.socket.on(SOCKET_RPC_EVENTS.ERROR as any, onError as any);
      this.socket.emit(SOCKET_RPC_EVENTS.REGISTER as any, { method });
    });
  }

  async rpcCall<T = RpcResponseEnvelope>(method: string, params: string, timeoutMs = 30_000): Promise<T> {
    return await this.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method, params }, timeoutMs);
  }

  emit(event: string, data: unknown): void {
    this.socket.emit(event as any, data);
  }
}

export function createUserScopedSocketCollector(baseUrl: string, token: string): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates',
    auth: { token, clientType: 'user-scoped' as const },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket);
}

export function createSessionScopedSocketCollector(baseUrl: string, token: string, sessionId: string): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates',
    auth: { token, clientType: 'session-scoped' as const, sessionId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket);
}
