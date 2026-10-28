import { isSocketIoAckTimeoutError } from '@happier-dev/protocol/rpcErrors';

import { resolveSessionControlSocketAckTimeoutMs } from './sessionTimeouts';

export type SocketAckError = Error & Readonly<{
    code: 'socket_not_connected' | 'socket_ack_timeout';
    event: string;
    retryable: true;
    timeoutMs?: number;
}>;

export type EmitWithAckSocket = {
    connected?: boolean;
    emitWithAck: (event: string, ...args: any[]) => Promise<unknown>;
    timeout?: (ms: number) => EmitWithAckSocket;
};

type EmitCallbackAckSocket = {
    connected?: boolean;
    emit: (event: string, payload: unknown, callback: (answer: unknown) => void) => unknown;
};

function createSocketAckError(params: Readonly<{
    code: SocketAckError['code'];
    event: string;
    message: string;
    timeoutMs?: number;
}>): SocketAckError {
    const error = new Error(params.message) as SocketAckError;
    Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    Object.defineProperty(error, 'event', { value: params.event, enumerable: true });
    Object.defineProperty(error, 'retryable', { value: true, enumerable: true });
    if (params.timeoutMs !== undefined) {
        Object.defineProperty(error, 'timeoutMs', { value: params.timeoutMs, enumerable: true });
    }
    return error;
}

function resolveAckTimeoutMs(timeoutMs: number | undefined): number {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : resolveSessionControlSocketAckTimeoutMs();
}

function assertSocketConnected(socket: Readonly<{ connected?: boolean }>, event: string): void {
    if (socket.connected === false) {
        throw createSocketAckError({
            code: 'socket_not_connected',
            event,
            message: `${event} socket is not connected`,
        });
    }
}

async function withLocalAckDeadline<T>(params: Readonly<{
    event: string;
    timeoutMs: number;
    operation: () => Promise<T>;
}>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            params.operation(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(createSocketAckError({
                        code: 'socket_ack_timeout',
                        event: params.event,
                        message: `${params.event} ack timed out after ${params.timeoutMs}ms`,
                        timeoutMs: params.timeoutMs,
                    }));
                }, params.timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

export async function emitSocketWithAck<T = unknown>(params: Readonly<{
    socket: EmitWithAckSocket;
    event: string;
    payload: unknown;
    timeoutMs?: number;
}>): Promise<T> {
    assertSocketConnected(params.socket, params.event);
    const timeoutMs = resolveAckTimeoutMs(params.timeoutMs);
    const socketWithTimeout = params.socket.timeout?.(timeoutMs) ?? params.socket;
    return await withLocalAckDeadline({
        event: params.event,
        timeoutMs,
        operation: async () => {
            try {
                return await socketWithTimeout.emitWithAck(params.event, params.payload) as T;
            } catch (error) {
                // Socket.IO registers its timer during emit, before our local deadline.
                // Normalize response loss so settlement retries its exact accepted identity.
                if (isSocketIoAckTimeoutError(error)) {
                    const timeout = createSocketAckError({
                        code: 'socket_ack_timeout',
                        event: params.event,
                        message: `${params.event} ack timed out after ${timeoutMs}ms`,
                        timeoutMs,
                    });
                    timeout.cause = error;
                    throw timeout;
                }
                throw error;
            }
        },
    });
}

export async function emitSocketCallbackAck<T = unknown>(params: Readonly<{
    socket: EmitCallbackAckSocket;
    event: string;
    payload: unknown;
    timeoutMs?: number;
}>): Promise<T> {
    assertSocketConnected(params.socket, params.event);
    const timeoutMs = resolveAckTimeoutMs(params.timeoutMs);
    return await withLocalAckDeadline({
        event: params.event,
        timeoutMs,
        operation: async () => await new Promise<T>((resolve) => {
            params.socket.emit(params.event, params.payload, (answer: unknown) => {
                resolve(answer as T);
            });
        }),
    });
}
