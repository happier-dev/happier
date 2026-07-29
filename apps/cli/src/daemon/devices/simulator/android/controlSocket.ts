import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

import {
    createAndroidScrcpyBinaryControlCommandWriter,
    createAndroidScrcpyControlSender,
    type AndroidScrcpyControlCommandWriter,
    type AndroidScrcpyControlPacketWriteResult,
    type AndroidScrcpyControlScreenSize,
    type AndroidScrcpyControlSender,
} from './control';

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 1_000;

type AndroidScrcpyControlSocketEvent = 'connect' | 'drain' | 'close' | 'error';
type AndroidScrcpyControlSocketListener = (error?: Error) => void;

export type AndroidScrcpyControlSocketLike = Readonly<{
    write(packet: Uint8Array): boolean;
    once(event: AndroidScrcpyControlSocketEvent, listener: AndroidScrcpyControlSocketListener): unknown;
    on?(event: AndroidScrcpyControlSocketEvent, listener: AndroidScrcpyControlSocketListener): unknown;
    off?(event: AndroidScrcpyControlSocketEvent, listener: AndroidScrcpyControlSocketListener): unknown;
    end?(): void;
    destroy?(error?: Error): void;
    setNoDelay?(noDelay: boolean): void;
    destroyed?: boolean;
    writableEnded?: boolean;
    closed?: boolean;
}>;

export type AndroidScrcpyControlSocketConnector = () =>
    | Promise<AndroidScrcpyControlSocketConnectResult>
    | AndroidScrcpyControlSocketConnectResult;

export type AndroidScrcpyControlSocketConnectResult = Readonly<
    | {
        ok: true;
        socket: AndroidScrcpyControlSocketLike;
        diagnostics?: readonly Record<string, unknown>[];
    }
    | {
        ok: false;
        status?: 'unavailable';
        reasonCode: string;
        diagnostics?: readonly Record<string, unknown>[];
    }
>;

export type AndroidScrcpyLiveControlSocket = Readonly<{
    sender: AndroidScrcpyControlSender;
    writeCommand: AndroidScrcpyControlCommandWriter;
    close: () => Promise<void>;
    readState: () => Readonly<{ status: 'ready' | 'closed' }>;
    diagnostics: readonly Record<string, unknown>[];
}>;

export type AndroidScrcpyLiveControlSocketResult = Readonly<
    | ({ ok: true } & AndroidScrcpyLiveControlSocket)
    | {
        ok: false;
        status: 'unavailable';
        reasonCode: string;
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type ConnectAndroidScrcpyLiveControlSocketInput = Readonly<{
    screenSize: AndroidScrcpyControlScreenSize;
    connect: AndroidScrcpyControlSocketConnector;
    writeDrainTimeoutMs?: number;
}>;

export type AndroidScrcpyTcpControlSocketConnectorInput = Readonly<{
    host?: string;
    port: number;
    connectTimeoutMs?: number;
}>;

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

function isSocketClosed(socket: AndroidScrcpyControlSocketLike): boolean {
    return socket.destroyed === true || socket.writableEnded === true || socket.closed === true;
}

function closedResult(code = 'scrcpy_control_socket_closed'): AndroidScrcpyControlPacketWriteResult {
    return {
        ok: false,
        status: 'unavailable',
        reasonCode: code,
        diagnostics: [{ code }],
    };
}

function writeFailureResult(error: unknown): AndroidScrcpyControlPacketWriteResult {
    return {
        ok: false,
        status: 'unavailable',
        reasonCode: 'scrcpy_control_socket_write_failed',
        diagnostics: [{
            code: 'scrcpy_control_socket_write_failed',
            errorName: errorName(error),
        }],
    };
}

function removeSocketListener(
    socket: AndroidScrcpyControlSocketLike,
    event: AndroidScrcpyControlSocketEvent,
    listener: AndroidScrcpyControlSocketListener,
): void {
    socket.off?.(event, listener);
}

function waitForDrain(input: Readonly<{
    socket: AndroidScrcpyControlSocketLike;
    timeoutMs: number;
}>): Promise<AndroidScrcpyControlPacketWriteResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: AndroidScrcpyControlPacketWriteResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeSocketListener(input.socket, 'drain', onDrain);
            removeSocketListener(input.socket, 'close', onClose);
            removeSocketListener(input.socket, 'error', onError);
            resolve(result);
        };
        const onDrain = (): void => finish({ ok: true });
        const onClose = (): void => finish(closedResult());
        const onError = (error?: Error): void => finish(writeFailureResult(error));
        const timer = setTimeout(() => {
            finish({
                ok: false,
                status: 'unavailable',
                reasonCode: 'scrcpy_control_socket_backpressure_timeout',
                diagnostics: [{ code: 'scrcpy_control_socket_backpressure_timeout' }],
            });
        }, Math.max(0, input.timeoutMs));

        input.socket.once('drain', onDrain);
        input.socket.once('close', onClose);
        input.socket.once('error', onError);
    });
}

function createSocketPacketWriter(input: Readonly<{
    socket: AndroidScrcpyControlSocketLike;
    readClosed: () => boolean;
    markClosed: () => void;
    writeDrainTimeoutMs: number;
}>): (packet: Uint8Array) => Promise<AndroidScrcpyControlPacketWriteResult> {
    return async (packet) => {
        if (input.readClosed() || isSocketClosed(input.socket)) {
            input.markClosed();
            return closedResult();
        }

        let accepted: boolean;
        try {
            accepted = input.socket.write(packet);
        } catch (error) {
            input.markClosed();
            return writeFailureResult(error);
        }

        if (accepted) return { ok: true };

        const drained = await waitForDrain({
            socket: input.socket,
            timeoutMs: input.writeDrainTimeoutMs,
        });
        if (!drained.ok) {
            if (drained.reasonCode === 'scrcpy_control_socket_closed') input.markClosed();
            return drained;
        }
        return drained;
    };
}

export async function connectAndroidScrcpyLiveControlSocket(
    input: ConnectAndroidScrcpyLiveControlSocketInput,
): Promise<AndroidScrcpyLiveControlSocketResult> {
    const connected = await input.connect();
    if (!connected.ok) {
        return {
            ok: false,
            status: connected.status ?? 'unavailable',
            reasonCode: connected.reasonCode,
            diagnostics: connected.diagnostics ?? [],
        };
    }

    const socket = connected.socket;
    socket.setNoDelay?.(true);

    let status: 'ready' | 'closed' = 'ready';
    const markClosed = (): void => {
        status = 'closed';
    };
    if (socket.on) {
        socket.on('close', markClosed);
        socket.on('error', markClosed);
    } else {
        socket.once('close', markClosed);
        socket.once('error', markClosed);
    }

    const writeCommand = createAndroidScrcpyBinaryControlCommandWriter({
        screenSize: input.screenSize,
        writePacket: createSocketPacketWriter({
            socket,
            readClosed: () => status === 'closed',
            markClosed,
            writeDrainTimeoutMs: input.writeDrainTimeoutMs ?? DEFAULT_WRITE_DRAIN_TIMEOUT_MS,
        }),
    });
    const sender = createAndroidScrcpyControlSender({
        writeCommand,
    });

    let closePromise: Promise<void> | null = null;
    const close = async (): Promise<void> => {
        if (closePromise) return await closePromise;
        closePromise = Promise.resolve().then(() => {
            if (status === 'closed') return;
            status = 'closed';
            if (!isSocketClosed(socket)) {
                if (socket.end) {
                    socket.end();
                    return;
                }
                socket.destroy?.();
            }
        });
        await closePromise;
    };

    return {
        ok: true,
        sender,
        writeCommand,
        close,
        readState: () => ({ status }),
        diagnostics: connected.diagnostics ?? [],
    };
}

export function createAndroidScrcpyTcpControlSocketConnector(
    input: AndroidScrcpyTcpControlSocketConnectorInput,
): AndroidScrcpyControlSocketConnector {
    return async () => {
        const host = input.host ?? '127.0.0.1';
        const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        const socket = createConnection({ host, port: input.port });

        return await new Promise<AndroidScrcpyControlSocketConnectResult>((resolve) => {
            let settled = false;
            const finish = (result: AndroidScrcpyControlSocketConnectResult): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.off('connect', onConnect);
                socket.off('error', onError);
                socket.off('close', onClose);
                resolve(result);
            };
            const onConnect = (): void => {
                socket.setNoDelay(true);
                finish({
                    ok: true,
                    socket: socket as Socket,
                    diagnostics: [{ code: 'scrcpy_control_socket_connected', host, port: input.port }],
                });
            };
            const onError = (error?: Error): void => {
                socket.destroy();
                finish({
                    ok: false,
                    status: 'unavailable',
                    reasonCode: 'scrcpy_control_socket_unavailable',
                    diagnostics: [{
                        code: 'scrcpy_control_socket_unavailable',
                        host,
                        port: input.port,
                        errorName: errorName(error),
                    }],
                });
            };
            const onClose = (): void => {
                finish({
                    ok: false,
                    status: 'unavailable',
                    reasonCode: 'scrcpy_control_socket_closed',
                    diagnostics: [{ code: 'scrcpy_control_socket_closed', host, port: input.port }],
                });
            };
            const timer = setTimeout(() => {
                socket.destroy();
                finish({
                    ok: false,
                    status: 'unavailable',
                    reasonCode: 'scrcpy_control_socket_unavailable',
                    diagnostics: [{ code: 'scrcpy_control_socket_connect_timeout', host, port: input.port }],
                });
            }, Math.max(0, connectTimeoutMs));

            socket.once('connect', onConnect);
            socket.once('error', onError);
            socket.once('close', onClose);
        });
    };
}
