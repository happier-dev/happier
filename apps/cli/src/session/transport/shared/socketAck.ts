import { resolveSessionControlSocketAckTimeoutMs } from './sessionTimeouts';

type AckableSocket<TEvent extends string = string, TPayload = unknown> = Readonly<{
  connected?: boolean;
  emitWithAck?(event: TEvent, payload: TPayload): Promise<unknown>;
  emit?(event: TEvent, payload: TPayload, callback: (answer: unknown) => void): void;
  timeout?(ms: number): AckableSocket<TEvent, TPayload>;
}>;

export type SocketAckErrorCode = 'socket_not_connected' | 'socket_ack_timeout';

export class SocketAckAbortError extends Error {
  readonly event: string;

  constructor(event: string) {
    super(`Socket ACK wait was cancelled for ${event}`);
    this.name = 'SocketAckAbortError';
    this.event = event;
  }
}

export class SocketAckError extends Error {
  readonly code: SocketAckErrorCode;
  readonly event: string;
  readonly retryable = true;
  readonly timeoutMs?: number;

  constructor(params: Readonly<{
    code: SocketAckErrorCode;
    event: string;
    timeoutMs?: number;
  }>) {
    super(params.code === 'socket_not_connected'
      ? `Socket is disconnected before ${params.event} ACK`
      : `Socket ACK timed out for ${params.event}`);
    this.name = 'SocketAckError';
    this.code = params.code;
    this.event = params.event;
    this.timeoutMs = params.timeoutMs;
  }
}

function resolveAckTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.min(60_000, Math.trunc(timeoutMs));
  }
  return resolveSessionControlSocketAckTimeoutMs();
}

function ensureSocketConnected(socket: AckableSocket, event: string): void {
  if (socket.connected === false) {
    throw new SocketAckError({ code: 'socket_not_connected', event });
  }
}

function createAckTimeoutPromise(event: string, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new SocketAckError({ code: 'socket_ack_timeout', event, timeoutMs })),
      timeoutMs,
    );
  });
}

export async function emitSocketWithAck<
  T = unknown,
  TEvent extends string = string,
  TPayload = unknown,
>(params: Readonly<{
  socket: AckableSocket<NoInfer<TEvent>, NoInfer<TPayload>>;
  event: TEvent;
  payload: TPayload;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<T> {
  ensureSocketConnected(params.socket, params.event);
  if (params.signal?.aborted) {
    throw new SocketAckAbortError(params.event);
  }
  const timeoutMs = resolveAckTimeoutMs(params.timeoutMs);
  const socketWithTimeout = params.socket.timeout?.(timeoutMs) ?? params.socket;
  if (typeof socketWithTimeout.emitWithAck !== 'function') {
    throw new Error(`Socket does not support emitWithAck for ${params.event}`);
  }

  const ackPromise = Promise.resolve(socketWithTimeout.emitWithAck(params.event, params.payload));
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let onAbort = () => {};
    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    onAbort = () => settle(() => reject(new SocketAckAbortError(params.event)));
    timeout = setTimeout(
      () => settle(() => reject(new SocketAckError({ code: 'socket_ack_timeout', event: params.event, timeoutMs }))),
      timeoutMs,
    );
    params.signal?.addEventListener('abort', onAbort, { once: true });
    ackPromise.then(
      (value) => settle(() => resolve(value as T)),
      (error) => settle(() => reject(error)),
    );
  });
}

export async function emitSocketCallbackAck<
  T = unknown,
  TEvent extends string = string,
  TPayload = unknown,
>(params: Readonly<{
  socket: AckableSocket<NoInfer<TEvent>, NoInfer<TPayload>>;
  event: TEvent;
  payload: TPayload;
  timeoutMs?: number;
}>): Promise<T> {
  ensureSocketConnected(params.socket, params.event);
  const timeoutMs = resolveAckTimeoutMs(params.timeoutMs);
  if (typeof params.socket.emit !== 'function') {
    throw new Error(`Socket does not support callback ACKs for ${params.event}`);
  }

  const ackPromise = new Promise<unknown>((resolve) => {
    params.socket.emit?.(params.event, params.payload, (answer: unknown) => resolve(answer));
  });
  return await Promise.race([ackPromise, createAckTimeoutPromise(params.event, timeoutMs)]) as T;
}
