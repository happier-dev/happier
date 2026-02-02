import { io, type Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

export type UpdateEvent = { id: string; seq: number; createdAt: number; body: { t: string; [k: string]: any } };
export type EphemeralEvent = { type: string; [k: string]: any };

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
    socket.on('connect_error', (err: any) =>
      this.events.push({ at: Date.now(), kind: 'connect_error', message: String(err?.message ?? err) }),
    );
    socket.on('update', (payload: any) => this.events.push({ at: Date.now(), kind: 'update', payload }));
    socket.on('ephemeral', (payload: any) => this.events.push({ at: Date.now(), kind: 'ephemeral', payload }));
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

  async emitWithAck<T = any>(event: string, data: any, timeoutMs = 10_000): Promise<T> {
    return (await this.socket.timeout(timeoutMs).emitWithAck(event as any, data)) as T;
  }

  onRpcRequest(handler: (data: { method: string; params: string }) => string | Promise<string>): () => void {
    const listener = async (data: { method: string; params: string }, callback: (response: string) => void) => {
      try {
        const out = await handler(data);
        callback(out);
      } catch (e: any) {
        callback(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
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

      const onRegistered = (data: any) => {
        if (data?.method !== method) return;
        cleanup();
        resolve();
      };

      const onError = (data: any) => {
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

  async rpcCall<T = any>(method: string, params: string): Promise<T> {
    return await this.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method, params }, 30_000);
  }

  emit(event: string, data: any): void {
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
