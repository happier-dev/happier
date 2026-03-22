import { io, type Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { attachSocketEventCollector, SocketEventCollector, type CapturedEvent } from './socketEventCollector';

export type { CapturedEvent } from './socketEventCollector';

type RpcRequestPayload = { method: string; params: string };
type RpcRegisterEventPayload = { method?: unknown; error?: unknown };
type RpcResponseEnvelope = { ok?: unknown; result?: unknown; error?: unknown; errorCode?: unknown };

export class SocketCollector {
  private readonly socket: Socket;
  private readonly eventCollector: SocketEventCollector;

  constructor(socket: Socket) {
    this.socket = socket;
    this.eventCollector = attachSocketEventCollector(socket);
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
    return this.eventCollector.getEvents();
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
        const message = e && typeof e === 'object' && 'message' in e ? String((e as { message?: unknown }).message ?? e) : String(e);
        callback(JSON.stringify({ ok: false, error: message }));
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

export function createSessionScopedSocketCollector(
  baseUrl: string,
  token: string,
  sessionId: string,
  machineId?: string,
): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates',
    auth: {
      token,
      clientType: 'session-scoped' as const,
      sessionId,
      ...(typeof machineId === 'string' ? { machineId } : {}),
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket);
}
