import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

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
  readonly retryable = false;

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
    cause?: unknown;
  }>) {
    super(params.code === 'socket_not_connected'
      ? `Socket is disconnected before ${params.event} ACK`
      : `Socket ACK timed out for ${params.event}`, { cause: params.cause });
    this.name = 'SocketAckError';
    this.code = params.code;
    this.event = params.event;
    this.timeoutMs = params.timeoutMs;
  }
}

function resolveAckTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.trunc(timeoutMs);
  }
  return resolveSessionControlSocketAckTimeoutMs();
}

function ensureSocketConnected(socket: Pick<AckableSocket, 'connected'>, event: string): void {
  if (socket.connected === false) {
    throw new SocketAckError({ code: 'socket_not_connected', event });
  }
}

function throwIfSocketMethodUnavailable(value: unknown, event: string): void {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== false
    || !('errorCode' in value) || value.errorCode !== RPC_ERROR_CODES.METHOD_NOT_FOUND
    || !('method' in value) || value.method !== event) return;
  throw Object.assign(new RpcError(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_FOUND), {
    method: event, retryable: false,
  });
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
  /** null keeps the wait under the containing operation's lifetime and cancellation. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}>): Promise<T> {
  ensureSocketConnected(params.socket, params.event);
  if (params.signal?.aborted) {
    throw new SocketAckAbortError(params.event);
  }
  const timeoutMs = params.timeoutMs === null ? null : resolveAckTimeoutMs(params.timeoutMs);
  const socketWithTimeout = timeoutMs === null ? params.socket : params.socket.timeout?.(timeoutMs) ?? params.socket;
  if (typeof socketWithTimeout.emitWithAck !== 'function') {
    throw new Error(`Socket does not support emitWithAck for ${params.event}`);
  }

  const ackPromise = Promise.resolve(socketWithTimeout.emitWithAck(params.event, params.payload));
  const value = await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
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
    if (timeoutMs !== null) {
      timeout = setTimeout(
        () => settle(() => reject(new SocketAckError({ code: 'socket_ack_timeout', event: params.event, timeoutMs }))),
        timeoutMs,
      );
    }
    params.signal?.addEventListener('abort', onAbort, { once: true });
    ackPromise.then(
      (value) => settle(() => resolve(value as T)),
      (error: unknown) => settle(() => reject(isSocketIoAckTimeoutError(error)
        ? new SocketAckError({ code: 'socket_ack_timeout', event: params.event, cause: error, ...(timeoutMs === null ? {} : { timeoutMs }) })
        : error)),
    );
  });
  throwIfSocketMethodUnavailable(value, params.event);
  return value;
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
  const value = await Promise.race([ackPromise, createAckTimeoutPromise(params.event, timeoutMs)]);
  throwIfSocketMethodUnavailable(value, params.event);
  return value as T;
}
