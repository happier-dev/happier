import { io, type Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { attachSocketEventCollector, SocketEventCollector, type CapturedEvent } from './socketEventCollector';

export type { CapturedEvent } from './socketEventCollector';

type RpcRequestPayload = { method: string; params: string };
type RpcRegisterEventPayload = { method?: unknown; error?: unknown };
type RpcResponseEnvelope = { ok?: unknown; result?: unknown; error?: unknown; errorCode?: unknown };
type SocketTransport = 'websocket' | 'polling';

export type SocketConnectivityTransition = Readonly<{
  sequence: number;
  kind: 'connect' | 'disconnect' | 'connect_error';
  at: number;
  reason?: string;
  message?: string;
}>;

export type SocketConnectivityState = Readonly<{
  connected: boolean;
  totalTransitionCount: number;
  transitions: readonly SocketConnectivityTransition[];
  lastConnectError?: {
    at: number;
    message: string;
  };
  lastDisconnect?: {
    at: number;
    reason?: string;
  };
}>;

type SocketCollectorRuntimeOptions = Readonly<{
  captureEvents?: boolean;
}>;

const MAX_CONNECTIVITY_TRANSITIONS = 16;

export class SocketCollector {
  private readonly socket: Socket;
  private readonly eventCollector: SocketEventCollector;
  private readonly captureEvents: boolean;
  private readonly connectivityState: {
    lastConnectError?: {
      at: number;
      message: string;
    };
    lastDisconnect?: {
      at: number;
      reason?: string;
    };
    totalTransitionCount: number;
    transitions: SocketConnectivityTransition[];
  };

  constructor(socket: Socket, options: SocketCollectorRuntimeOptions = {}) {
    this.socket = socket;
    this.captureEvents = options.captureEvents ?? true;
    this.eventCollector = this.captureEvents
      ? attachSocketEventCollector(socket)
      : new SocketEventCollector();
    this.connectivityState = {
      totalTransitionCount: 0,
      transitions: [],
    };
    socket.on('connect', () => {
      this.recordConnectivityTransition({
        kind: 'connect',
        at: Date.now(),
      });
      this.connectivityState.lastConnectError = undefined;
      this.connectivityState.lastDisconnect = undefined;
    });
    socket.on('disconnect', (reason?: string) => {
      const at = Date.now();
      this.connectivityState.lastDisconnect = {
        at,
        ...(typeof reason === 'string' ? { reason } : {}),
      };
      this.recordConnectivityTransition({
        kind: 'disconnect',
        at,
        ...(typeof reason === 'string' ? { reason } : {}),
      });
    });
    socket.on('connect_error', (error: unknown) => {
      const message = error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? error)
        : String(error);
      const at = Date.now();
      this.connectivityState.lastConnectError = {
        at,
        message,
      };
      this.recordConnectivityTransition({
        kind: 'connect_error',
        at,
        message,
      });
    });
  }

  private recordConnectivityTransition(
    transition: Omit<SocketConnectivityTransition, 'sequence'>,
  ): void {
    this.connectivityState.totalTransitionCount += 1;
    this.connectivityState.transitions.push({
      sequence: this.connectivityState.totalTransitionCount,
      ...transition,
    });
    if (this.connectivityState.transitions.length > MAX_CONNECTIVITY_TRANSITIONS) {
      this.connectivityState.transitions.splice(
        0,
        this.connectivityState.transitions.length - MAX_CONNECTIVITY_TRANSITIONS,
      );
    }
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

  getConnectivityState(): SocketConnectivityState {
    return {
      connected: this.socket.connected,
      totalTransitionCount: this.connectivityState.totalTransitionCount,
      transitions: this.connectivityState.transitions.map((transition) => ({ ...transition })),
      ...(this.connectivityState.lastConnectError ? { lastConnectError: { ...this.connectivityState.lastConnectError } } : {}),
      ...(this.connectivityState.lastDisconnect ? { lastDisconnect: { ...this.connectivityState.lastDisconnect } } : {}),
    };
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
    return await this.emitWithAck(
      SOCKET_RPC_EVENTS.CALL,
      { method, params, timeoutMs },
      timeoutMs,
    );
  }

  emit(event: string, data: unknown): void {
    this.socket.emit(event as any, data);
  }
}

type SocketCollectorOptions = Readonly<{
  transports?: readonly SocketTransport[];
  connectTimeoutMs?: number;
  autoReconnect?: boolean;
  captureEvents?: boolean;
}>;

export function createUserScopedSocketCollector(baseUrl: string, token: string, options?: SocketCollectorOptions): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates/',
    auth: { token, clientType: 'user-scoped' as const },
    transports: [...(options?.transports ?? ['websocket'])],
    timeout: options?.connectTimeoutMs,
    reconnection: options?.autoReconnect ?? true,
    reconnectionAttempts: options?.autoReconnect === false ? 0 : Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket, { captureEvents: options?.captureEvents });
}

export function createSessionScopedSocketCollector(
  baseUrl: string,
  token: string,
  sessionId: string,
  machineId?: string,
  options?: SocketCollectorOptions,
): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates/',
    auth: {
      token,
      clientType: 'session-scoped' as const,
      sessionId,
      ...(typeof machineId === 'string' ? { machineId } : {}),
    },
    transports: [...(options?.transports ?? ['websocket'])],
    timeout: options?.connectTimeoutMs,
    reconnection: options?.autoReconnect ?? true,
    reconnectionAttempts: options?.autoReconnect === false ? 0 : Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket, { captureEvents: options?.captureEvents });
}

export function createMachineScopedSocketCollector(
  baseUrl: string,
  token: string,
  machineId: string,
  options?: SocketCollectorOptions,
): SocketCollector {
  const socket = io(baseUrl, {
    path: '/v1/updates/',
    auth: {
      token,
      clientType: 'machine-scoped' as const,
      machineId,
    },
    transports: [...(options?.transports ?? ['websocket'])],
    timeout: options?.connectTimeoutMs,
    reconnection: options?.autoReconnect ?? true,
    reconnectionAttempts: options?.autoReconnect === false ? 0 : Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
  });
  return new SocketCollector(socket, { captureEvents: options?.captureEvents });
}
