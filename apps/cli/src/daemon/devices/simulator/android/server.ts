import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

import type { AndroidSimulatorAdapterUnavailableReasonV1 } from '@happier-dev/protocol';

import {
    resolveAndroidScrcpyServerArtifact,
    type AndroidScrcpyServerArtifactResolution,
} from './artifact';
import type {
    AndroidScrcpyControlScreenSize,
    AndroidScrcpyControlSender,
} from './control';
import {
    connectAndroidScrcpyLiveControlSocket,
    type AndroidScrcpyControlSocketConnector,
    type AndroidScrcpyControlSocketLike,
    type AndroidScrcpyLiveControlSocket,
} from './controlSocket';
import { createAndroidSimulatorUnavailableHealth } from './diagnostics';
import {
    defaultAndroidToolRunner,
    type AndroidToolRunResult,
    type AndroidToolRunner,
} from './process';
import {
    parseAdbDevicesLongOutput,
    resolveAndroidAdbTooling,
    type AndroidAdbToolingResolution,
} from './tooling';

const DEFAULT_ADB_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_PROBE_MS = 250;
const DEFAULT_TUNNEL_HOST = '127.0.0.1';
const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_TCP_CONNECT_STABILITY_PROBE_MS = 75;
const DEFAULT_TUNNEL_CONNECT_RETRY_DELAY_MS = 50;
const DEFAULT_TUNNEL_CONNECT_RETRY_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 512;
const REMOTE_SCRCPY_ROOT = '/data/local/tmp/happier';
const SCRCPY_SERVER_CLASS = 'com.genymobile.scrcpy.Server';
const SCRCPY_SOCKET_NAME = 'scrcpy';

export type AndroidScrcpyServerAdbRunner = AndroidToolRunner;

export type AndroidScrcpyServerTransportStatus =
    | 'starting'
    | 'running'
    | 'stopping'
    | 'stopped';

export type AndroidScrcpyServerArtifactState = Readonly<{
    path: string;
    version: string;
    digest: string;
}>;

export type AndroidScrcpyServerHandleState = Readonly<{
    serial: string;
    artifact: AndroidScrcpyServerArtifactState;
    remotePath: string;
    transportStatus: AndroidScrcpyServerTransportStatus;
}>;

export type AndroidScrcpyServerStopResult = Readonly<{
    status: 'stopped';
    diagnostics: readonly Record<string, unknown>[];
}>;

export type AndroidScrcpyServerProcessHandle = Readonly<{
    pid?: number;
    rawVideoStream?: AsyncIterable<Uint8Array>;
    stop?: () => Promise<void> | void;
}>;

export type AndroidScrcpyServerProcessStartResult = Readonly<
    | {
        ok: true;
        process?: AndroidScrcpyServerProcessHandle;
    }
    | {
        ok: false;
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
        timedOut?: true;
        aborted?: true;
        errorName?: string;
    }
>;

export type AndroidScrcpyServerProcessStarter = (
    input: Readonly<{
        command: string;
        args: readonly string[];
        signal?: AbortSignal;
    }>,
) => Promise<AndroidScrcpyServerProcessStartResult>;

export type AndroidScrcpyServerTunnelSocketPurpose = 'video' | 'control';

export type AndroidScrcpyServerTunnelSocketLike =
    & Partial<AndroidScrcpyControlSocketLike>
    & Partial<AsyncIterable<Uint8Array>>;

export type AndroidScrcpyServerTunnelSocketConnectResult = Readonly<
    | {
        ok: true;
        socket: AndroidScrcpyServerTunnelSocketLike;
        diagnostics?: readonly Record<string, unknown>[];
    }
    | {
        ok: false;
        reasonCode: string;
        diagnostics?: readonly Record<string, unknown>[];
    }
>;

export type AndroidScrcpyServerTunnelSocketConnector = (
    input: Readonly<{
        host: string;
        port: number;
        purpose: AndroidScrcpyServerTunnelSocketPurpose;
        signal?: AbortSignal;
    }>,
) => Promise<AndroidScrcpyServerTunnelSocketConnectResult> | AndroidScrcpyServerTunnelSocketConnectResult;

export type AndroidScrcpyServerHandle = Readonly<{
    state: AndroidScrcpyServerHandleState;
    rawVideoStream?: AsyncIterable<Uint8Array>;
    sendScrcpyControl?: AndroidScrcpyControlSender;
    readState: () => AndroidScrcpyServerHandleState;
    stop: () => Promise<AndroidScrcpyServerStopResult>;
}>;

export type AndroidScrcpyServerHandleResult = Readonly<
    | {
        ok: true;
        handle: AndroidScrcpyServerHandle;
    }
    | {
        ok: false;
        reasonCode: AndroidSimulatorAdapterUnavailableReasonV1;
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type EnsureAndroidScrcpyServerInput = Readonly<{
    serial: string;
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution> | AndroidAdbToolingResolution;
    resolveScrcpyServerArtifact?: () => Promise<AndroidScrcpyServerArtifactResolution> | AndroidScrcpyServerArtifactResolution;
    runAdb?: AndroidScrcpyServerAdbRunner;
    startServer?: AndroidScrcpyServerProcessStarter;
    controlSocket?: Readonly<{
        screenSize: AndroidScrcpyControlScreenSize;
        connect?: AndroidScrcpyControlSocketConnector;
        writeDrainTimeoutMs?: number;
    }>;
    tunnel?: Readonly<{
        localPort: number;
        host?: string;
        connectTcpSocket?: AndroidScrcpyServerTunnelSocketConnector;
    }>;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

function boundDiagnosticOutput(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= MAX_DIAGNOSTIC_OUTPUT_BYTES) return value;
    return bytes.subarray(0, MAX_DIAGNOSTIC_OUTPUT_BYTES).toString('utf8');
}

function sanitizeRemotePathSegment(value: string): string {
    const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/g, '_');
    return sanitized.length > 0 ? sanitized : 'unknown';
}

function digestRemotePathSegment(digest: string): string {
    const separator = digest.indexOf(':');
    return sanitizeRemotePathSegment(separator >= 0 ? digest.slice(separator + 1) : digest);
}

function remoteScrcpyServerDirectory(artifact: AndroidScrcpyServerArtifactState): string {
    return [
        REMOTE_SCRCPY_ROOT,
        'scrcpy-server',
        sanitizeRemotePathSegment(artifact.version),
        digestRemotePathSegment(artifact.digest),
    ].join('/');
}

function remoteScrcpyServerPath(artifact: AndroidScrcpyServerArtifactState): string {
    return `${remoteScrcpyServerDirectory(artifact)}/scrcpy-server.jar`;
}

function parentRemoteDirectories(remoteDirectory: string): readonly string[] {
    const directories: string[] = [];
    let current = remoteDirectory;
    while (current.startsWith(REMOTE_SCRCPY_ROOT) && current.length >= REMOTE_SCRCPY_ROOT.length) {
        directories.push(current);
        if (current === REMOTE_SCRCPY_ROOT) break;
        const separator = current.lastIndexOf('/');
        if (separator <= REMOTE_SCRCPY_ROOT.length) {
            current = REMOTE_SCRCPY_ROOT;
        } else {
            current = current.slice(0, separator);
        }
    }
    return directories;
}

/**
 * Encoder launch parameters for the scrcpy server. In `raw_stream=true` mode these are FIXED at
 * launch — the only way to change bitrate / fps / resolution at runtime is to restart the server
 * with new values (see `restartProducer.ts`). All fields optional: omitting one keeps scrcpy's
 * default for that parameter.
 */
export type AndroidScrcpyServerEncoderParamsV1 = Readonly<{
    /** Target H.264 bitrate in bits per second → scrcpy `video_bit_rate`. */
    videoBitRateBps?: number;
    /** Frame-rate cap → scrcpy `max_fps`. */
    maxFps?: number;
    /** Longest-edge resolution cap (px) → scrcpy `max_size`. 0/omitted = native. */
    maxSize?: number;
    /** Audio capture toggle → scrcpy `audio`. Defaults to false (video-only). */
    audio?: boolean;
}>;

function isPositiveInteger(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function encoderLaunchArgs(encoder: AndroidScrcpyServerEncoderParamsV1 | undefined): readonly string[] {
    if (!encoder) return [];
    const args: string[] = [];
    if (isPositiveInteger(encoder.videoBitRateBps)) args.push(`video_bit_rate=${encoder.videoBitRateBps}`);
    if (isPositiveInteger(encoder.maxFps)) args.push(`max_fps=${encoder.maxFps}`);
    if (isPositiveInteger(encoder.maxSize)) args.push(`max_size=${encoder.maxSize}`);
    return args;
}

function startServerArgs(input: Readonly<{
    serial: string;
    remotePath: string;
    version: string;
    controlSocketEnabled?: boolean;
    tunnelForward?: boolean;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
}>): readonly string[] {
    const audioEnabled = input.encoder?.audio === true;
    return [
        '-s',
        input.serial,
        'shell',
        `CLASSPATH=${input.remotePath}`,
        'app_process',
        '/',
        SCRCPY_SERVER_CLASS,
        input.version,
        'log_level=info',
        ...(input.tunnelForward ? ['tunnel_forward=true'] : []),
        `audio=${audioEnabled ? 'true' : 'false'}`,
        input.controlSocketEnabled ? 'control=true' : 'control=false',
        'cleanup=false',
        'raw_stream=true',
        ...encoderLaunchArgs(input.encoder),
    ];
}

function failure(input: Readonly<{
    reasonCode: AndroidSimulatorAdapterUnavailableReasonV1;
    diagnostics?: readonly Record<string, unknown>[];
}>): AndroidScrcpyServerHandleResult {
    createAndroidSimulatorUnavailableHealth({
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    });
    return {
        ok: false,
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    };
}

function commandFailureDiagnostic(input: Readonly<{
    code: string;
    operation: string;
    serial: string;
    result: AndroidToolRunResult;
}>): Record<string, unknown> {
    return {
        platform: 'android',
        severity: 'error',
        code: input.code,
        operation: input.operation,
        serial: input.serial,
        exitCode: input.result.exitCode,
        ...(boundDiagnosticOutput(input.result.stdout) ? { stdout: boundDiagnosticOutput(input.result.stdout) } : {}),
        ...(boundDiagnosticOutput(input.result.stderr) ? { stderr: boundDiagnosticOutput(input.result.stderr) } : {}),
        ...(input.result.timedOut ? { timedOut: true } : {}),
        ...(input.result.aborted ? { aborted: true } : {}),
        ...(input.result.errorName ? { errorName: input.result.errorName } : {}),
    };
}

function startFailureDiagnostic(input: Readonly<{
    serial: string;
    result: Exclude<AndroidScrcpyServerProcessStartResult, { ok: true }>;
}>): Record<string, unknown> {
    return {
        platform: 'android',
        severity: 'error',
        code: 'scrcpy_server_start_failed',
        operation: 'adb_shell_app_process_scrcpy_server',
        serial: input.serial,
        ...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
        ...(boundDiagnosticOutput(input.result.stdout) ? { stdout: boundDiagnosticOutput(input.result.stdout) } : {}),
        ...(boundDiagnosticOutput(input.result.stderr) ? { stderr: boundDiagnosticOutput(input.result.stderr) } : {}),
        ...(input.result.timedOut ? { timedOut: true } : {}),
        ...(input.result.aborted ? { aborted: true } : {}),
        ...(input.result.errorName ? { errorName: input.result.errorName } : {}),
    };
}

function tunnelFailureDiagnostic(input: Readonly<{
    code: string;
    operation: string;
    serial: string;
    localPort?: number;
    result?: AndroidToolRunResult;
    errorName?: string;
}>): Record<string, unknown> {
    return {
        platform: 'android',
        severity: 'error',
        code: input.code,
        operation: input.operation,
        serial: input.serial,
        ...(input.localPort !== undefined ? { localPort: input.localPort } : {}),
        ...(input.result?.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
        ...(input.result?.timedOut ? { timedOut: true } : {}),
        ...(input.result?.aborted ? { aborted: true } : {}),
        ...(input.result?.errorName ? { errorName: input.result.errorName } : {}),
        ...(input.errorName ? { errorName: input.errorName } : {}),
    };
}

async function runAdbCommand(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    args: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<AndroidToolRunResult> {
    return await input.runner({
        command: input.adb.command,
        args: input.args,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
}

function isAsyncIterableSocket(
    socket: AndroidScrcpyServerTunnelSocketLike,
): socket is AndroidScrcpyServerTunnelSocketLike & AsyncIterable<Uint8Array> {
    return typeof socket[Symbol.asyncIterator] === 'function';
}

function isControlSocketLike(
    socket: AndroidScrcpyServerTunnelSocketLike,
): socket is AndroidScrcpyControlSocketLike {
    return typeof socket.write === 'function' && typeof socket.once === 'function';
}

async function closeTunnelSocket(socket: AndroidScrcpyServerTunnelSocketLike | undefined): Promise<void> {
    if (!socket) return;
    await Promise.resolve().then(() => {
        if (socket.closed || socket.destroyed || socket.writableEnded) return;
        if (socket.end) {
            socket.end();
            return;
        }
        socket.destroy?.();
    });
}

export function createDefaultAndroidScrcpyServerTunnelSocketConnector(input: Readonly<{
    connectTimeoutMs?: number;
    stabilityProbeMs?: number;
}> = {}): AndroidScrcpyServerTunnelSocketConnector {
    return async (connectInput) => {
        const socket = createConnection({ host: connectInput.host, port: connectInput.port });
        return await new Promise<AndroidScrcpyServerTunnelSocketConnectResult>((resolve) => {
            let settled = false;
            let connectStabilityTimer: ReturnType<typeof setTimeout> | null = null;
            let abortListener: (() => void) | null = null;
            const clearTimers = (): void => {
                clearTimeout(connectTimeoutTimer);
                if (connectStabilityTimer) clearTimeout(connectStabilityTimer);
            };
            const removeAbortListener = (): void => {
                if (!abortListener) return;
                connectInput.signal?.removeEventListener('abort', abortListener);
                abortListener = null;
            };
            const finish = (result: AndroidScrcpyServerTunnelSocketConnectResult, keepSocket = false): void => {
                if (settled) return;
                settled = true;
                clearTimers();
                removeAbortListener();
                socket.off('connect', onConnect);
                socket.off('error', onError);
                socket.off('close', onClose);
                if (!keepSocket) socket.destroy();
                resolve(result);
            };
            const onConnect = (): void => {
                socket.setNoDelay(true);
                const connected = {
                    ok: true as const,
                    socket: socket as Socket & AsyncIterable<Uint8Array>,
                    diagnostics: [{
                        code: 'scrcpy_tunnel_socket_connected',
                        host: connectInput.host,
                        port: connectInput.port,
                        purpose: connectInput.purpose,
                    }],
                };
                const stabilityProbeMs = Math.max(0, input.stabilityProbeMs ?? DEFAULT_TCP_CONNECT_STABILITY_PROBE_MS);
                if (stabilityProbeMs === 0) {
                    finish(connected, true);
                    return;
                }
                // adb forward can accept locally before the device-side localabstract socket exists.
                connectStabilityTimer = setTimeout(() => finish(connected, true), stabilityProbeMs);
            };
            const onError = (error?: Error): void => {
                finish({
                    ok: false,
                    reasonCode: 'scrcpy_tunnel_socket_unavailable',
                    diagnostics: [{
                        code: 'scrcpy_tunnel_socket_unavailable',
                        host: connectInput.host,
                        port: connectInput.port,
                        purpose: connectInput.purpose,
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    }],
                });
            };
            const onClose = (): void => {
                finish({
                    ok: false,
                    reasonCode: 'scrcpy_tunnel_socket_closed',
                    diagnostics: [{
                        code: 'scrcpy_tunnel_socket_closed',
                        host: connectInput.host,
                        port: connectInput.port,
                        purpose: connectInput.purpose,
                    }],
                });
            };
            const onAbort = (): void => {
                finish({
                    ok: false,
                    reasonCode: 'scrcpy_tunnel_socket_unavailable',
                    diagnostics: [{
                        code: 'scrcpy_tunnel_socket_connect_aborted',
                        host: connectInput.host,
                        port: connectInput.port,
                        purpose: connectInput.purpose,
                    }],
                });
            };
            const connectTimeoutTimer = setTimeout(() => {
                finish({
                    ok: false,
                    reasonCode: 'scrcpy_tunnel_socket_unavailable',
                    diagnostics: [{
                        code: 'scrcpy_tunnel_socket_connect_timeout',
                        host: connectInput.host,
                        port: connectInput.port,
                        purpose: connectInput.purpose,
                    }],
                });
            }, Math.max(0, input.connectTimeoutMs ?? DEFAULT_TCP_CONNECT_TIMEOUT_MS));

            if (connectInput.signal?.aborted) {
                onAbort();
                return;
            }
            if (connectInput.signal) {
                abortListener = onAbort;
                connectInput.signal.addEventListener('abort', abortListener, { once: true });
            }
            socket.once('connect', onConnect);
            socket.once('error', onError);
            socket.once('close', onClose);
        });
    };
}

function isTransientTunnelSocketFailure(result: Exclude<AndroidScrcpyServerTunnelSocketConnectResult, { ok: true }>): boolean {
    return result.reasonCode === 'scrcpy_tunnel_socket_closed'
        || result.reasonCode === 'scrcpy_tunnel_socket_unavailable';
}

async function waitForTunnelRetryDelay(input: Readonly<{
    delayMs: number;
    signal?: AbortSignal;
}>): Promise<void> {
    if (input.delayMs <= 0) return;
    if (input.signal?.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.delayMs);
        input.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

async function connectTunnelSocketWithRetry(input: Readonly<{
    tunnel: {
        host: string;
        localPort: number;
        connectTcpSocket: AndroidScrcpyServerTunnelSocketConnector;
    };
    purpose: AndroidScrcpyServerTunnelSocketPurpose;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<AndroidScrcpyServerTunnelSocketConnectResult> {
    const deadlineMs = Date.now() + Math.min(input.timeoutMs, DEFAULT_TUNNEL_CONNECT_RETRY_TIMEOUT_MS);
    let lastFailure: Exclude<AndroidScrcpyServerTunnelSocketConnectResult, { ok: true }> | null = null;

    do {
        const connected = await input.tunnel.connectTcpSocket({
            host: input.tunnel.host,
            port: input.tunnel.localPort,
            purpose: input.purpose,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (connected.ok) return connected;
        lastFailure = connected;
        if (!isTransientTunnelSocketFailure(connected) || input.signal?.aborted) {
            return connected;
        }
        await waitForTunnelRetryDelay({
            delayMs: DEFAULT_TUNNEL_CONNECT_RETRY_DELAY_MS,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    } while (Date.now() < deadlineMs);

    return lastFailure ?? {
        ok: false,
        reasonCode: 'scrcpy_tunnel_socket_unavailable',
        diagnostics: [{ code: 'scrcpy_tunnel_socket_retry_exhausted', purpose: input.purpose }],
    };
}

async function openAdbForwardTunnel(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    serial: string;
    localPort: number;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true } | { ok: false; diagnostics: readonly Record<string, unknown>[] }>> {
    const result = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['-s', input.serial, 'forward', `tcp:${input.localPort}`, `localabstract:${SCRCPY_SOCKET_NAME}`],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.exitCode === 0) return { ok: true };
    return {
        ok: false,
        diagnostics: [tunnelFailureDiagnostic({
            code: 'scrcpy_adb_forward_failed',
            operation: 'adb_forward_scrcpy_socket',
            serial: input.serial,
            localPort: input.localPort,
            result,
        })],
    };
}

async function closeAdbForwardTunnel(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    serial: string;
    localPort: number;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<readonly Record<string, unknown>[]> {
    const result = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['-s', input.serial, 'forward', '--remove', `tcp:${input.localPort}`],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return result.exitCode === 0
        ? []
        : [tunnelFailureDiagnostic({
            code: 'scrcpy_adb_forward_remove_failed',
            operation: 'adb_forward_remove_scrcpy_socket',
            serial: input.serial,
            localPort: input.localPort,
            result,
        })];
}

async function assertEmulatorReady(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    serial: string;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true } | { ok: false; reasonCode: AndroidSimulatorAdapterUnavailableReasonV1; diagnostics: readonly Record<string, unknown>[] }>> {
    const devices = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['devices', '-l'],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (devices.exitCode !== 0) {
        return {
            ok: false,
            reasonCode: 'android_emulator_unavailable',
            diagnostics: [commandFailureDiagnostic({
                code: 'adb_devices_failed',
                operation: 'adb_devices_long',
                serial: input.serial,
                result: devices,
            })],
        };
    }

    const parsed = parseAdbDevicesLongOutput(devices.stdout);
    const device = parsed.records.find((record) => record.serial === input.serial);
    if (!device) {
        return {
            ok: false,
            reasonCode: 'android_emulator_unavailable',
            diagnostics: [
                ...parsed.diagnostics,
                {
                    platform: 'android',
                    severity: 'error',
                    code: 'android_emulator_not_found',
                    serial: input.serial,
                },
            ],
        };
    }
    if (device.state === 'unauthorized') {
        return {
            ok: false,
            reasonCode: 'android_device_unauthorized',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                code: 'android_device_unauthorized',
                serial: input.serial,
                state: device.state,
            }],
        };
    }
    if (device.state !== 'device') {
        return {
            ok: false,
            reasonCode: 'android_device_offline',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                code: 'android_device_offline',
                serial: input.serial,
                state: device.state,
            }],
        };
    }
    return { ok: true };
}

async function pushScrcpyServer(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    serial: string;
    artifact: AndroidScrcpyServerArtifactState;
    remoteDirectory: string;
    remotePath: string;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true } | { ok: false; diagnostics: readonly Record<string, unknown>[] }>> {
    const mkdir = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['-s', input.serial, 'shell', 'mkdir', '-p', input.remoteDirectory],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (mkdir.exitCode !== 0) {
        return {
            ok: false,
            diagnostics: [commandFailureDiagnostic({
                code: 'scrcpy_server_push_failed',
                operation: 'adb_create_scrcpy_server_dir',
                serial: input.serial,
                result: mkdir,
            })],
        };
    }

    const push = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['-s', input.serial, 'push', input.artifact.path, input.remotePath],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (push.exitCode !== 0) {
        return {
            ok: false,
            diagnostics: [commandFailureDiagnostic({
                code: 'scrcpy_server_push_failed',
                operation: 'adb_push_scrcpy_server',
                serial: input.serial,
                result: push,
            })],
        };
    }

    return { ok: true };
}

function copyState(state: AndroidScrcpyServerHandleState): AndroidScrcpyServerHandleState {
    return {
        serial: state.serial,
        artifact: { ...state.artifact },
        remotePath: state.remotePath,
        transportStatus: state.transportStatus,
    };
}

async function cleanupRemoteScrcpyServer(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    serial: string;
    remotePath: string;
    remoteDirectory: string;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<readonly Record<string, unknown>[]> {
    const diagnostics: Record<string, unknown>[] = [];
    const removeServer = await runAdbCommand({
        adb: input.adb,
        runner: input.runner,
        args: ['-s', input.serial, 'shell', 'rm', '-f', input.remotePath],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (removeServer.exitCode !== 0) {
        diagnostics.push(commandFailureDiagnostic({
            code: 'scrcpy_server_cleanup_failed',
            operation: 'adb_remove_scrcpy_server',
            serial: input.serial,
            result: removeServer,
        }));
    }

    for (const directory of parentRemoteDirectories(input.remoteDirectory)) {
        const removeDirectory = await runAdbCommand({
            adb: input.adb,
            runner: input.runner,
            args: ['-s', input.serial, 'shell', 'rmdir', directory],
            timeoutMs: input.timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (removeDirectory.exitCode !== 0) {
            diagnostics.push(commandFailureDiagnostic({
                code: 'scrcpy_server_cleanup_failed',
                operation: 'adb_remove_scrcpy_server_dir',
                serial: input.serial,
                result: removeDirectory,
            }));
        }
    }
    return diagnostics;
}

function createAndroidScrcpyServerHandle(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidScrcpyServerAdbRunner;
    timeoutMs: number;
    serial: string;
    artifact: AndroidScrcpyServerArtifactState;
    remotePath: string;
    remoteDirectory: string;
    process?: AndroidScrcpyServerProcessHandle;
    rawVideoStream?: AsyncIterable<Uint8Array>;
    videoSocket?: AndroidScrcpyServerTunnelSocketLike;
    controlSocket?: AndroidScrcpyLiveControlSocket;
    tunnel?: Readonly<{
        localPort: number;
    }>;
}>): AndroidScrcpyServerHandle {
    const state = {
        serial: input.serial,
        artifact: input.artifact,
        remotePath: input.remotePath,
        transportStatus: 'running' as AndroidScrcpyServerTransportStatus,
    };
    let stopPromise: Promise<AndroidScrcpyServerStopResult> | null = null;

    const stop = async (): Promise<AndroidScrcpyServerStopResult> => {
        if (stopPromise) return await stopPromise;
        state.transportStatus = 'stopping';
        stopPromise = (async () => {
            const diagnostics: Record<string, unknown>[] = [];

            if (input.controlSocket) {
                try {
                    await input.controlSocket.close();
                } catch (error) {
                    diagnostics.push({
                        platform: 'android',
                        severity: 'warning',
                        code: 'scrcpy_control_socket_close_failed',
                        serial: input.serial,
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    });
                }
            }

            try {
                await closeTunnelSocket(input.videoSocket);
            } catch (error) {
                diagnostics.push({
                    platform: 'android',
                    severity: 'warning',
                    code: 'scrcpy_video_socket_close_failed',
                    serial: input.serial,
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                });
            }

            if (input.process?.stop) {
                try {
                    await input.process.stop();
                } catch (error) {
                    diagnostics.push({
                        platform: 'android',
                        severity: 'warning',
                        code: 'scrcpy_server_process_stop_failed',
                        serial: input.serial,
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    });
                }
            }

            if (input.tunnel) {
                diagnostics.push(...await closeAdbForwardTunnel({
                    adb: input.adb,
                    runner: input.runner,
                    serial: input.serial,
                    localPort: input.tunnel.localPort,
                    timeoutMs: input.timeoutMs,
                }));
            }

            diagnostics.push(...await cleanupRemoteScrcpyServer({
                adb: input.adb,
                runner: input.runner,
                serial: input.serial,
                remotePath: input.remotePath,
                remoteDirectory: input.remoteDirectory,
                timeoutMs: input.timeoutMs,
            }));

            state.transportStatus = 'stopped';
            return {
                status: 'stopped',
                diagnostics,
            };
        })();
        return await stopPromise;
    };

    return {
        state,
        ...(input.rawVideoStream ?? input.process?.rawVideoStream
            ? { rawVideoStream: input.rawVideoStream ?? input.process?.rawVideoStream }
            : {}),
        ...(input.controlSocket ? { sendScrcpyControl: input.controlSocket.sender } : {}),
        readState: () => copyState(state),
        stop,
    };
}

export function createDefaultAndroidScrcpyServerProcessStarter(input: Readonly<{
    startupProbeMs?: number;
}> = {}): AndroidScrcpyServerProcessStarter {
    const startupProbeMs = input.startupProbeMs ?? DEFAULT_STARTUP_PROBE_MS;
    return async (startInput) => {
        let stdout = '';
        let stderr = '';
        try {
            const child = spawn(startInput.command, [...startInput.args], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(startInput.signal ? { signal: startInput.signal } : {}),
            });
            // stdout carries the raw H.264 stream when `raw_stream=true`; do not attach a
            // diagnostic data listener here because that would drain bytes before capture reads them.
            child.stderr.on('data', (chunk: Buffer) => {
                stderr = boundDiagnosticOutput(`${stderr}${chunk.toString('utf8')}`) ?? '';
            });

            const earlyFailure = await new Promise<Exclude<AndroidScrcpyServerProcessStartResult, { ok: true }> | null>((resolve) => {
                const timer = setTimeout(() => resolve(null), startupProbeMs);
                const finish = (result: Exclude<AndroidScrcpyServerProcessStartResult, { ok: true }>) => {
                    clearTimeout(timer);
                    resolve(result);
                };
                child.once('error', (error) => finish({
                    ok: false,
                    stdout,
                    stderr,
                    errorName: error.name,
                }));
                child.once('exit', (exitCode) => finish({
                    ok: false,
                    exitCode,
                    stdout,
                    stderr,
                }));
            });
            if (earlyFailure) return earlyFailure;

            return {
                ok: true,
                process: {
                    ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
                    ...(child.stdout ? { rawVideoStream: child.stdout } : {}),
                    stop: () => {
                        if (child.exitCode === null && !child.killed) {
                            child.kill('SIGTERM');
                        }
                    },
                },
            };
        } catch (error) {
            return {
                ok: false,
                stdout,
                stderr,
                errorName: error instanceof Error ? error.name : 'UnknownError',
            };
        }
    };
}

export async function ensureAndroidScrcpyServer(
    input: EnsureAndroidScrcpyServerInput,
): Promise<AndroidScrcpyServerHandleResult> {
    const serial = input.serial.trim();
    if (!serial.startsWith('emulator-')) {
        return failure({
            reasonCode: 'physical_device_not_supported_v1',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                code: 'physical_device_not_supported_v1',
                serial,
            }],
        });
    }

    const resolveAdb = input.resolveAdbTooling ?? (() => resolveAndroidAdbTooling({
        ...(input.signal ? { signal: input.signal } : {}),
    }));
    const adb = await resolveAdb();
    if (!adb.ok) {
        return failure({
            reasonCode: adb.reasonCode,
            diagnostics: adb.diagnostics,
        });
    }

    const resolveArtifact = input.resolveScrcpyServerArtifact ?? resolveAndroidScrcpyServerArtifact;
    const artifact = await resolveArtifact();
    if (!artifact.ok) {
        return failure({
            reasonCode: artifact.reasonCode,
            diagnostics: artifact.diagnostics,
        });
    }

    const runner = input.runAdb ?? defaultAndroidToolRunner;
    const timeoutMs = input.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS;
    const ready = await assertEmulatorReady({
        adb,
        runner,
        serial,
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!ready.ok) {
        return failure({
            reasonCode: ready.reasonCode,
            diagnostics: ready.diagnostics,
        });
    }

    const artifactState = {
        path: artifact.path,
        version: artifact.version,
        digest: artifact.digest,
    };
    const remoteDirectory = remoteScrcpyServerDirectory(artifactState);
    const remotePath = remoteScrcpyServerPath(artifactState);
    const pushed = await pushScrcpyServer({
        adb,
        runner,
        serial,
        artifact: artifactState,
        remoteDirectory,
        remotePath,
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!pushed.ok) {
        return failure({
            reasonCode: 'scrcpy_server_push_failed',
            diagnostics: pushed.diagnostics,
        });
    }

    const tunnel = input.tunnel
        ? {
            host: input.tunnel.host ?? DEFAULT_TUNNEL_HOST,
            localPort: input.tunnel.localPort,
            connectTcpSocket: input.tunnel.connectTcpSocket ?? createDefaultAndroidScrcpyServerTunnelSocketConnector(),
        }
        : null;
    if (tunnel) {
        const opened = await openAdbForwardTunnel({
            adb,
            runner,
            serial,
            localPort: tunnel.localPort,
            timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!opened.ok) {
            const cleanupDiagnostics = await cleanupRemoteScrcpyServer({
                adb,
                runner,
                serial,
                remotePath,
                remoteDirectory,
                timeoutMs,
            });
            return failure({
                reasonCode: 'android_emulator_bridge_unavailable',
                diagnostics: [...opened.diagnostics, ...cleanupDiagnostics],
            });
        }
    }

    const startServer = input.startServer ?? createDefaultAndroidScrcpyServerProcessStarter();
    const started = await startServer({
        command: adb.command,
        args: startServerArgs({
            serial,
            remotePath,
            version: artifact.version,
            controlSocketEnabled: Boolean(input.controlSocket),
            tunnelForward: Boolean(tunnel),
            ...(input.encoder ? { encoder: input.encoder } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!started.ok) {
        const diagnostics: Record<string, unknown>[] = [startFailureDiagnostic({ serial, result: started })];
        if (tunnel) {
            diagnostics.push(...await closeAdbForwardTunnel({
                adb,
                runner,
                serial,
                localPort: tunnel.localPort,
                timeoutMs,
            }));
        }
        diagnostics.push(...await cleanupRemoteScrcpyServer({
            adb,
            runner,
            serial,
            remotePath,
            remoteDirectory,
            timeoutMs,
        }));
        return failure({
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics,
        });
    }

    let videoSocket: AndroidScrcpyServerTunnelSocketLike | null = null;
    let tunnelRawVideoStream: AsyncIterable<Uint8Array> | null = null;
    if (tunnel) {
        const connected = await connectTunnelSocketWithRetry({
            tunnel,
            purpose: 'video',
            timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!connected.ok || !isAsyncIterableSocket(connected.socket)) {
            const diagnostics: Record<string, unknown>[] = connected.ok
                ? [tunnelFailureDiagnostic({
                    code: 'scrcpy_video_socket_unavailable',
                    operation: 'connect_scrcpy_video_socket',
                    serial,
                    localPort: tunnel.localPort,
                })]
                : [...(connected.diagnostics ?? [{ code: connected.reasonCode }])];
            if (connected.ok) await closeTunnelSocket(connected.socket);
            try {
                await started.process?.stop?.();
            } catch (error) {
                diagnostics.push({
                    platform: 'android',
                    severity: 'warning',
                    code: 'scrcpy_server_process_stop_failed',
                    serial,
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                });
            }
            diagnostics.push(...await closeAdbForwardTunnel({
                adb,
                runner,
                serial,
                localPort: tunnel.localPort,
                timeoutMs,
            }));
            diagnostics.push(...await cleanupRemoteScrcpyServer({
                adb,
                runner,
                serial,
                remotePath,
                remoteDirectory,
                timeoutMs,
            }));
            return failure({
                reasonCode: 'android_emulator_bridge_unavailable',
                diagnostics,
            });
        }
        videoSocket = connected.socket;
        tunnelRawVideoStream = connected.socket;
    }

    const tunnelControlSocketConnect: AndroidScrcpyControlSocketConnector | null = input.controlSocket && tunnel
        ? async () => {
            const connected = await connectTunnelSocketWithRetry({
                tunnel,
                purpose: 'control',
                timeoutMs,
                ...(input.signal ? { signal: input.signal } : {}),
            });
            if (!connected.ok) return connected;
            if (isControlSocketLike(connected.socket)) {
                return {
                    ok: true,
                    socket: connected.socket,
                    diagnostics: connected.diagnostics,
                };
            }
            await closeTunnelSocket(connected.socket);
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: 'scrcpy_control_socket_unavailable',
                diagnostics: [{
                    code: 'scrcpy_control_socket_unavailable',
                    operation: 'connect_scrcpy_control_socket',
                    serial,
                    localPort: tunnel.localPort,
                }],
            };
        }
        : null;
    const controlSocketConnect = input.controlSocket?.connect ?? tunnelControlSocketConnect;
    const controlSocket = input.controlSocket
        ? await connectAndroidScrcpyLiveControlSocket({
            screenSize: input.controlSocket.screenSize,
            connect: controlSocketConnect ?? (async () => ({
                ok: false,
                reasonCode: 'scrcpy_control_socket_unavailable',
                diagnostics: [{ code: 'scrcpy_control_socket_connector_missing' }],
            })),
            ...(input.controlSocket.writeDrainTimeoutMs ? { writeDrainTimeoutMs: input.controlSocket.writeDrainTimeoutMs } : {}),
        })
        : null;
    if (controlSocket && !controlSocket.ok) {
        const diagnostics: Record<string, unknown>[] = [...controlSocket.diagnostics];
        await closeTunnelSocket(videoSocket ?? undefined).catch((error: unknown) => {
            diagnostics.push({
                platform: 'android',
                severity: 'warning',
                code: 'scrcpy_video_socket_close_failed',
                serial,
                errorName: error instanceof Error ? error.name : 'UnknownError',
            });
        });
        try {
            await started.process?.stop?.();
        } catch (error) {
            diagnostics.push({
                platform: 'android',
                severity: 'warning',
                code: 'scrcpy_server_process_stop_failed',
                serial,
                errorName: error instanceof Error ? error.name : 'UnknownError',
            });
        }
        if (tunnel) {
            diagnostics.push(...await closeAdbForwardTunnel({
                adb,
                runner,
                serial,
                localPort: tunnel.localPort,
                timeoutMs,
            }));
        }
        diagnostics.push(...await cleanupRemoteScrcpyServer({
            adb,
            runner,
            serial,
            remotePath,
            remoteDirectory,
            timeoutMs,
        }));
        return failure({
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics: diagnostics.length > 0
                ? diagnostics
                : [{ code: controlSocket.reasonCode }],
        });
    }

    return {
        ok: true,
        handle: createAndroidScrcpyServerHandle({
            adb,
            runner,
            timeoutMs,
            serial,
            artifact: artifactState,
            remotePath,
            remoteDirectory,
            ...(started.process ? { process: started.process } : {}),
            ...(tunnelRawVideoStream ? { rawVideoStream: tunnelRawVideoStream } : {}),
            ...(videoSocket ? { videoSocket } : {}),
            ...(controlSocket?.ok ? { controlSocket } : {}),
            ...(tunnel ? { tunnel: { localPort: tunnel.localPort } } : {}),
        }),
    };
}
