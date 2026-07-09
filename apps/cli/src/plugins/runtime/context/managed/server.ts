import type {
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    ExecLaunchInputV1,
    ManagedServerHandleV1,
    ManagedServerRuntimeServiceV1,
    ManagedServerHealthCheckV1,
    ManagedServerDiagnosticsV1,
    ManagedServerSnapshotV1,
    ManagedServerSpecV1,
} from '@happier-dev/plugin-sdk';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalServiceLoopbackHostV1Schema } from '@happier-dev/protocol';

import { basename } from 'node:path';

import { createPluginExecService } from '../exec';
import {
    createManagedServerDiagnosticSanitizer,
    sanitizeManagedServerDiagnosticText,
    sanitizeManagedServerDiagnosticUrl,
    type ManagedServerDiagnosticSanitizer,
} from './diagnostics';
import {
    createManagedServerDurableLogCapture,
    pruneManagedServerDurableLogs,
    type ManagedServerDurableLogCapture,
} from './durableLog';

type PluginManagedServerDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

type ManagedServerProcessInfo = Readonly<{
    pid: number;
    ppid: number;
    command: string;
}>;

type ManagedServerProcessReaper = Readonly<{
    listProcesses: () => Promise<readonly ManagedServerProcessInfo[]>;
    signalProcess: (pid: number, signal: string) => void | Promise<void>;
}>;

type ManagedServerMode = NonNullable<ManagedServerSnapshotV1['mode']>;
type ManagedServerCredential = NonNullable<NonNullable<ManagedServerSpecV1['mode']>['credential']>;
type ManagedServerOrphanReaperSpec = NonNullable<ManagedServerSpecV1['orphanReaper']>;
type ManagedServerWatchdogSpec = NonNullable<ManagedServerSpecV1['watchdog']>;

export type PluginManagedServerErrorCode =
    | 'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED'
    | 'PLUGIN_MANAGED_SERVER_HEALTH_TIMEOUT'
    | 'PLUGIN_MANAGED_SERVER_PROCESS_EXITED'
    | 'PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED'
    | 'PLUGIN_MANAGED_SERVER_WATCHDOG_TIMEOUT';

export class PluginManagedServerError extends Error {
    readonly code: PluginManagedServerErrorCode;

    constructor(code: PluginManagedServerErrorCode, message: string) {
        super(message);
        this.name = 'PluginManagedServerError';
        this.code = code;
    }
}

export type CreatePluginManagedServerServiceParams = Readonly<{
    exec?: ExecRuntimeServiceV1;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginManagedServerDisposable) => unknown;
    processReaper?: ManagedServerProcessReaper;
    now?: () => number;
}>;

function createSnapshot(params: ManagedServerSnapshotV1): ManagedServerSnapshotV1 {
    return Object.freeze({ ...params });
}

function createAbortError(): Error {
    const error = new Error('Plugin managed server operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };
        const finish = (handler: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            handler();
        };
        const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
        const onAbort = () => {
            clearTimeout(timer);
            finish(() => reject(createAbortError()));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

type ComposedAbortSignal = Readonly<{
    signal: AbortSignal;
    dispose: () => void;
}>;

type ResolvedManagedServerEndpoint = Readonly<{
    mode: ManagedServerMode;
    baseUrl: string | null;
    port: number | null;
    credential: ManagedServerCredential | null;
}>;

type ResolvedManagedServerHealthCheck = Readonly<
    | {
        kind: 'http';
        url: string;
        headers: Readonly<Record<string, string>>;
        timeoutMs?: number;
    }
    | {
        kind: 'command';
        launch: Extract<ManagedServerHealthCheckV1, { kind: 'command' }>['launch'];
        timeoutMs?: number;
    }
>;

const MANAGED_SERVER_OUTPUT_TAIL_BYTES = 8 * 1024;
const DEFAULT_ORPHAN_REAPER_INITIAL_SIGNAL = 'SIGTERM';
const DEFAULT_ORPHAN_REAPER_FORCE_SIGNAL = 'SIGKILL';
const DEFAULT_ORPHAN_REAPER_FORCE_AFTER_MS = 1_000;

const execFileAsync = promisify(execFile);

function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): ComposedAbortSignal {
    const controller = new AbortController();
    const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const entry of listeners) {
            entry.signal.removeEventListener('abort', entry.listener);
        }
        listeners.length = 0;
    };
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason ?? createAbortError());
        }
        dispose();
    };
    for (const signal of signals) {
        if (!signal) {
            continue;
        }
        if (signal.aborted) {
            abort(signal);
            break;
        }
        const listener = () => abort(signal);
        signal.addEventListener('abort', listener, { once: true });
        listeners.push({ signal, listener });
    }
    return Object.freeze({
        signal: controller.signal,
        dispose,
    });
}

function isSuccessfulCommandHealth(result: ExecRunResultV1): boolean {
    return result.exitCode === 0;
}

function readUrlPort(baseUrl: string): number | null {
    const parsed = new URL(baseUrl);
    if (parsed.port) {
        return Number(parsed.port);
    }
    if (parsed.protocol === 'http:') {
        return 80;
    }
    if (parsed.protocol === 'https:') {
        return 443;
    }
    return null;
}

function isLoopbackHostname(hostname: string): boolean {
    return LocalServiceLoopbackHostV1Schema.safeParse(hostname).success;
}

function assertLoopbackHttpHealthCheck(url: string): void {
    const parsed = new URL(url);
    if (!isLoopbackHostname(parsed.hostname)) {
        throw new Error(`ctx.managedServer HTTP health checks must target loopback URLs, received '${parsed.origin}'`);
    }
}

function joinBaseUrlPath(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.replace(/\/+$/u, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
}

function readOutputTail(output: string): string {
    if (output.length <= MANAGED_SERVER_OUTPUT_TAIL_BYTES) {
        return output;
    }
    return output.slice(-MANAGED_SERVER_OUTPUT_TAIL_BYTES);
}

async function allocateLoopbackPort(host: string): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (!address || typeof address === 'string') {
                    reject(new Error('Managed server port allocation did not return a TCP address'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

function parsePsProcessLine(line: string): ManagedServerProcessInfo | null {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) {
        return null;
    }
    return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3] ?? '',
    };
}

async function listSystemProcesses(): Promise<readonly ManagedServerProcessInfo[]> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
        maxBuffer: 1024 * 1024,
    });
    return stdout
        .split('\n')
        .map(parsePsProcessLine)
        .filter((processInfo): processInfo is ManagedServerProcessInfo => processInfo !== null);
}

function signalSystemProcess(pid: number, signal: string): void {
    try {
        process.kill(pid, signal);
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && (error as Readonly<{ code?: unknown }>).code === 'ESRCH'
        ) {
            return;
        }
        throw error;
    }
}

function createDefaultProcessReaper(): ManagedServerProcessReaper {
    return {
        listProcesses: listSystemProcesses,
        signalProcess: signalSystemProcess,
    };
}

function isManagedServerOrphanCandidate(
    processInfo: ManagedServerProcessInfo,
    reaper: ManagedServerOrphanReaperSpec,
): boolean {
    if (processInfo.ppid !== 1) {
        return false;
    }
    const executablePath = reaper.executablePath.trim();
    if (!executablePath) {
        return false;
    }
    const command = processInfo.command.trim();
    if (command !== executablePath && !command.startsWith(`${executablePath} `)) {
        return false;
    }
    return (reaper.commandIncludes ?? []).every((part) => command.includes(part));
}

function createProcessKey(processInfo: ManagedServerProcessInfo): string {
    return `${processInfo.pid}:${processInfo.command}`;
}

async function signalOrphanProcess(
    processReaper: ManagedServerProcessReaper,
    processInfo: ManagedServerProcessInfo,
    reaper: ManagedServerOrphanReaperSpec,
): Promise<void> {
    const initialSignal = reaper.initialSignal ?? DEFAULT_ORPHAN_REAPER_INITIAL_SIGNAL;
    await processReaper.signalProcess(processInfo.pid, initialSignal);
    const forceSignal = reaper.forceSignal ?? DEFAULT_ORPHAN_REAPER_FORCE_SIGNAL;
    const forceAfterMs = reaper.forceAfterMs ?? DEFAULT_ORPHAN_REAPER_FORCE_AFTER_MS;
    const forceTimer = setTimeout(() => {
        void Promise.resolve(processReaper.signalProcess(processInfo.pid, forceSignal)).catch(() => undefined);
    }, Math.max(0, forceAfterMs));
    forceTimer.unref?.();
}

async function resolveEndpoint(spec: ManagedServerSpecV1): Promise<ResolvedManagedServerEndpoint> {
    if (spec.mode?.kind === 'external-attach') {
        return {
            mode: 'external-attach',
            baseUrl: spec.mode.baseUrl.replace(/\/+$/u, ''),
            port: readUrlPort(spec.mode.baseUrl),
            credential: spec.mode.credential ?? null,
        };
    }
    if (spec.mode?.kind === 'managed-spawn') {
        const explicitBaseUrl = spec.mode.baseUrl?.replace(/\/+$/u, '');
        const explicitBaseUrlPort = explicitBaseUrl ? readUrlPort(explicitBaseUrl) : null;
        const host = spec.mode.host ?? (explicitBaseUrl ? new URL(explicitBaseUrl).hostname : '127.0.0.1');
        const port = spec.mode.port ?? explicitBaseUrlPort ?? await allocateLoopbackPort(host);
        if (explicitBaseUrlPort !== null && explicitBaseUrlPort !== port) {
            throw new Error(
                `Managed server '${spec.id}' managed-spawn baseUrl port ${explicitBaseUrlPort} must match managed-spawn port ${port}`,
            );
        }
        const baseUrl = explicitBaseUrl ?? `http://${host}:${port}`;
        return {
            mode: 'managed-spawn',
            baseUrl,
            port,
            credential: spec.mode.credential ?? null,
        };
    }
    return {
        mode: 'managed-spawn',
        baseUrl: null,
        port: null,
        credential: null,
    };
}

function mergeHeaders(...headers: readonly (Readonly<Record<string, string>> | undefined)[]): Readonly<Record<string, string>> {
    return Object.freeze(Object.assign({}, ...headers));
}

function createCredentialHeaders(credential: ManagedServerCredential | null): Readonly<Record<string, string>> | undefined {
    if (!credential?.httpHeader) {
        return undefined;
    }
    return {
        [credential.httpHeader.name]: credential.httpHeader.value,
    };
}

function resolveHealthCheck(
    spec: ManagedServerSpecV1,
    endpoint: ResolvedManagedServerEndpoint,
): ResolvedManagedServerHealthCheck {
    const healthCheck = spec.healthCheck;
    if (!healthCheck) {
        throw new PluginManagedServerError(
            'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED',
            `Managed server '${spec.id}' cannot report healthy without a declared health check`,
        );
    }
    if (healthCheck.kind === 'command') {
        return healthCheck;
    }
    const url = healthCheck.path && endpoint.baseUrl
        ? joinBaseUrlPath(endpoint.baseUrl, healthCheck.path)
        : healthCheck.url;
    if (!url) {
        throw new PluginManagedServerError(
            'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED',
            `Managed server '${spec.id}' HTTP health check requires a URL or endpoint-relative path`,
        );
    }
    assertLoopbackHttpHealthCheck(url);
    return {
        kind: 'http',
        url,
        headers: mergeHeaders(healthCheck.headers, createCredentialHeaders(endpoint.credential)),
        timeoutMs: healthCheck.timeoutMs,
    };
}

function resolveLaunch(spec: ManagedServerSpecV1, endpoint: ResolvedManagedServerEndpoint): ExecLaunchInputV1 {
    if (!spec.launch) {
        throw new Error(`Managed server '${spec.id}' managed-spawn mode requires a launch spec`);
    }
    if (spec.mode?.kind !== 'managed-spawn') {
        return spec.launch;
    }
    if (spec.launch.kind === 'ipc') {
        return spec.launch;
    }
    const env: Record<string, string> = {
        ...spec.launch.env,
    };
    if (spec.mode.baseUrlEnvKey && endpoint.baseUrl) {
        env[spec.mode.baseUrlEnvKey] = endpoint.baseUrl;
    }
    if (spec.mode.portEnvKey && endpoint.port !== null) {
        env[spec.mode.portEnvKey] = String(endpoint.port);
    }
    if (endpoint.credential) {
        env[endpoint.credential.envKey] = endpoint.credential.value;
    }
    const args = [...(spec.launch.args ?? [])];
    if (spec.mode.portArg && endpoint.port !== null) {
        args.push(spec.mode.portArg, String(endpoint.port));
    }
    return {
        ...spec.launch,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
    };
}

function createProcessExitedError(
    spec: ManagedServerSpecV1,
    result: ExecRunResultV1,
    diagnosticSanitizer: ManagedServerDiagnosticSanitizer,
    timing: 'before-healthy' | 'after-healthy' = 'before-healthy',
): PluginManagedServerError {
    const diagnostics = createProcessExitDiagnostics(result, diagnosticSanitizer);
    const outputDetails = [
        diagnostics.stderrTail,
        diagnostics.stdoutTail,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const timingMessage = timing === 'after-healthy'
        ? 'exited after becoming healthy'
        : 'exited before becoming healthy';
    return new PluginManagedServerError(
        'PLUGIN_MANAGED_SERVER_PROCESS_EXITED',
        `Managed server '${spec.id}' ${timingMessage}`
            + (outputDetails.length > 0 ? `\n${outputDetails.join('\n')}` : ''),
    );
}

function createProcessExitDiagnostics(
    result: ExecRunResultV1,
    diagnosticSanitizer: ManagedServerDiagnosticSanitizer,
): ManagedServerDiagnosticsV1 {
    const stdoutTail = sanitizeManagedServerDiagnosticText(readOutputTail(result.stdout), diagnosticSanitizer);
    const stderrTail = sanitizeManagedServerDiagnosticText(readOutputTail(result.stderr), diagnosticSanitizer);
    return {
        exitCode: result.exitCode,
        exitSignal: result.signal,
        ...(stdoutTail ? { stdoutTail } : {}),
        ...(stderrTail ? { stderrTail } : {}),
    };
}

async function runHealthCheck(params: Readonly<{
    spec: ManagedServerSpecV1;
    healthCheck: ResolvedManagedServerHealthCheck;
    exec: ExecRuntimeServiceV1;
    signal: AbortSignal | undefined;
}>): Promise<boolean> {
    const healthCheck = params.healthCheck;
    if (healthCheck.kind === 'command') {
        const result = await params.exec.run(healthCheck.launch, {
            signal: params.signal,
            timeoutMs: healthCheck.timeoutMs,
        });
        return isSuccessfulCommandHealth(result);
    }
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(createAbortError()), Math.max(0, healthCheck.timeoutMs ?? 1_000));
    const composed = composeAbortSignals([params.signal, timeoutController.signal]);
    try {
        const response = await fetch(healthCheck.url, {
            method: 'GET',
            headers: healthCheck.headers,
            signal: composed.signal,
        });
        return response.ok;
    } catch (error) {
        if (composed.signal.aborted && params.signal?.aborted === true) {
            throw createAbortError();
        }
        return false;
    } finally {
        clearTimeout(timer);
        composed.dispose();
    }
}

export function createPluginManagedServerService(
    params: CreatePluginManagedServerServiceParams = {},
): ManagedServerRuntimeServiceV1 {
    const exec = params.exec ?? createPluginExecService();
    const processReaper = params.processReaper ?? createDefaultProcessReaper();
    const now = params.now ?? Date.now;
    const service: ManagedServerRuntimeServiceV1 = Object.freeze({
        async supervise(spec: ManagedServerSpecV1): Promise<ManagedServerHandleV1> {
            const restart = (spec as unknown as Readonly<{ restart?: unknown }>).restart;
            if (restart !== undefined && restart !== 'never') {
                throw new PluginManagedServerError(
                    'PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED',
                    `Managed server '${spec.id}' restart policy is not supported by this host binding yet`,
                );
            }
            const endpoint = await resolveEndpoint(spec);
            const healthCheck = resolveHealthCheck(spec, endpoint);
            const launch = endpoint.mode === 'managed-spawn' ? resolveLaunch(spec, endpoint) : null;
            let previousPeriodicOrphanKeys = new Set<string>();
            const reapOrphans = async (options?: Readonly<{ mode?: 'initial' | 'periodic' }>): Promise<void> => {
                if (endpoint.mode !== 'managed-spawn' || !spec.orphanReaper) {
                    return;
                }
                const mode = options?.mode ?? 'initial';
                const candidates = (await processReaper.listProcesses())
                    .filter((processInfo) => isManagedServerOrphanCandidate(processInfo, spec.orphanReaper as ManagedServerOrphanReaperSpec));
                if (mode === 'initial') {
                    previousPeriodicOrphanKeys = new Set();
                    await Promise.all(candidates.map((processInfo) => signalOrphanProcess(
                        processReaper,
                        processInfo,
                        spec.orphanReaper as ManagedServerOrphanReaperSpec,
                    )));
                    return;
                }
                const currentKeys = new Set(candidates.map(createProcessKey));
                const confirmed = candidates.filter((processInfo) => previousPeriodicOrphanKeys.has(createProcessKey(processInfo)));
                previousPeriodicOrphanKeys = currentKeys;
                await Promise.all(confirmed.map((processInfo) => signalOrphanProcess(
                    processReaper,
                    processInfo,
                    spec.orphanReaper as ManagedServerOrphanReaperSpec,
                )));
            };
            await reapOrphans({ mode: 'initial' });
            const diagnosticSanitizer = createManagedServerDiagnosticSanitizer({
                credential: endpoint.credential,
                healthCheck,
                launch,
            });
            // Durable per-server log (managed-spawn only, opt-in via spec.durableLog). Teeing the
            // post-spawn output here persists it for later incident diagnosis. Shared by every
            // managed-server provider (OpenCode serve, Codex app-server, …). Best-effort: a log I/O
            // failure must never affect the supervised process.
            const durableLog: ManagedServerDurableLogCapture | null = endpoint.mode === 'managed-spawn'
                && spec.durableLog?.enabled === true
                ? createManagedServerDurableLogCapture({
                    ...(spec.durableLog.dir ? { logsDir: spec.durableLog.dir } : {}),
                    id: spec.id,
                    commandBasename: launch && launch.kind === 'binary' ? basename(launch.executablePath) : spec.id,
                    args: launch && launch.kind !== 'ipc' ? (launch.args ?? []) : [],
                    ...(endpoint.baseUrl ? { hostname: new URL(endpoint.baseUrl).hostname } : {}),
                    port: endpoint.port,
                    baseUrl: endpoint.baseUrl,
                    spawnPid: null,
                    ...(spec.launchFingerprint ? { launchFingerprint: spec.launchFingerprint } : {}),
                    sanitizer: diagnosticSanitizer,
                })
                : null;
            const logPath = durableLog?.logPath ?? null;
            const startedAt = now();
            let disposed = false;
            let terminalError: PluginManagedServerError | null = null;
            let watchdogTimer: ReturnType<typeof setInterval> | null = null;
            let lastLivenessAt: number | null = null;
            let snapshot = createSnapshot({
                id: spec.id,
                state: 'starting',
                mode: endpoint.mode,
                baseUrl: endpoint.baseUrl,
                port: endpoint.port,
                credentialEnvKey: endpoint.credential?.envKey ?? null,
                pid: null,
                startedAt,
                lastHealthyAt: null,
                lastErrorMessage: null,
                ...(logPath ? { logPath } : {}),
                diagnostics: {
                    ...(healthCheck.kind === 'http'
                        ? { healthCheckUrl: sanitizeManagedServerDiagnosticUrl(healthCheck.url, diagnosticSanitizer) }
                        : {}),
                },
            });
            const markUnhealthy = (error: PluginManagedServerError, diagnostics?: ManagedServerDiagnosticsV1): void => {
                terminalError = error;
                snapshot = createSnapshot({
                    ...snapshot,
                    state: 'unhealthy',
                    lastErrorMessage: error.message,
                    ...(diagnostics
                        ? {
                            diagnostics: {
                                ...snapshot.diagnostics,
                                ...diagnostics,
                            },
                        }
                        : {}),
                });
            };
            const pulseLiveness = (): void => {
                lastLivenessAt = now();
                if (snapshot.state === 'healthy') {
                    snapshot = createSnapshot({
                        ...snapshot,
                        lastHealthyAt: lastLivenessAt,
                    });
                }
            };
            const startWatchdog = (watchdog: ManagedServerWatchdogSpec | undefined): void => {
                if (!watchdog || watchdogTimer) {
                    return;
                }
                const intervalMs = Math.max(1, watchdog.intervalMs);
                const missedIntervals = Math.max(1, watchdog.missedIntervals);
                watchdogTimer = setInterval(() => {
                    if (disposed || snapshot.state !== 'healthy' || lastLivenessAt === null) {
                        return;
                    }
                    const missedForMs = now() - lastLivenessAt;
                    if (missedForMs < intervalMs * missedIntervals) {
                        return;
                    }
                    const error = new PluginManagedServerError(
                        'PLUGIN_MANAGED_SERVER_WATCHDOG_TIMEOUT',
                        `Managed server '${spec.id}' watchdog missed ${missedIntervals} liveness intervals`,
                    );
                    markUnhealthy(error);
                }, intervalMs);
                watchdogTimer.unref?.();
            };
            const processHandle = endpoint.mode === 'managed-spawn'
                ? await exec.spawn(launch ?? resolveLaunch(spec, endpoint), {
                    signal: spec.signal ?? params.signal,
                    ...(durableLog
                        ? { outputTee: { onChunk: (stream, chunk) => durableLog.write(stream, Buffer.from(chunk)) } }
                        : {}),
                })
                : null;
            if (durableLog && processHandle) {
                // Best-effort: prune old logs by count once the current log exists (never the current).
                void pruneManagedServerDurableLogs({
                    ...(spec.durableLog?.dir ? { logsDir: spec.durableLog.dir } : {}),
                    ...(spec.durableLog?.keepCount !== undefined ? { keepCount: spec.durableLog.keepCount } : {}),
                    keepPath: durableLog.logPath,
                }).catch(() => undefined);
            }
            let exitResult: ExecRunResultV1 | null = null;
            const readExitResult = (): ExecRunResultV1 | null => exitResult;
            if (processHandle) {
                void processHandle.exit.then((result) => {
                    exitResult = result;
                    if (!disposed) {
                        const error = createProcessExitedError(
                            spec,
                            result,
                            diagnosticSanitizer,
                            snapshot.state === 'healthy' ? 'after-healthy' : 'before-healthy',
                        );
                        markUnhealthy(error, createProcessExitDiagnostics(result, diagnosticSanitizer));
                    }
                }).catch((error: unknown) => {
                    if (!disposed && snapshot.state !== 'healthy') {
                        snapshot = createSnapshot({
                            ...snapshot,
                            state: 'unhealthy',
                            lastErrorMessage: sanitizeManagedServerDiagnosticText(
                                error instanceof Error ? error.message : 'Managed server process exited before becoming healthy',
                                diagnosticSanitizer,
                            ),
                        });
                    }
                });
                snapshot = createSnapshot({
                    ...snapshot,
                    pid: processHandle.pid,
                });
            }
            const handle: ManagedServerHandleV1 = Object.freeze({
                snapshot: () => snapshot,
                async waitUntilHealthy(options) {
                    const timeoutMs = options?.timeoutMs ?? spec.startupTimeoutMs ?? 30_000;
                    const deadline = now() + Math.max(0, timeoutMs);
                    while (now() <= deadline) {
                        assertNotAborted(options?.signal ?? spec.signal ?? params.signal);
                        if (terminalError) {
                            throw terminalError;
                        }
                        const observedExitResult = readExitResult();
                        if (observedExitResult) {
                            const error = createProcessExitedError(spec, observedExitResult, diagnosticSanitizer);
                            markUnhealthy(error, createProcessExitDiagnostics(observedExitResult, diagnosticSanitizer));
                            throw error;
                        }
                        let healthy: boolean;
                        try {
                            healthy = await runHealthCheck({
                                spec,
                                healthCheck,
                                exec,
                                signal: options?.signal ?? spec.signal ?? params.signal,
                            });
                        } catch (error) {
                            snapshot = createSnapshot({
                                ...snapshot,
                                state: 'unhealthy',
                                lastErrorMessage: sanitizeManagedServerDiagnosticText(
                                    error instanceof Error ? error.message : 'Managed server health check failed',
                                    diagnosticSanitizer,
                                ),
                            });
                            throw error;
                        }
                        if (healthy) {
                            await Promise.resolve();
                            const latestExitResult = readExitResult();
                            if (latestExitResult) {
                                const error = createProcessExitedError(spec, latestExitResult, diagnosticSanitizer);
                                markUnhealthy(error, createProcessExitDiagnostics(latestExitResult, diagnosticSanitizer));
                                throw error;
                            }
                            pulseLiveness();
                            snapshot = createSnapshot({
                                ...snapshot,
                                state: 'healthy',
                                lastHealthyAt: lastLivenessAt,
                                lastErrorMessage: null,
                            });
                            startWatchdog(spec.watchdog);
                            return snapshot;
                        }
                        await delay(Math.min(25, Math.max(0, deadline - now())), options?.signal ?? spec.signal ?? params.signal);
                    }
                    const error = new PluginManagedServerError(
                        'PLUGIN_MANAGED_SERVER_HEALTH_TIMEOUT',
                        `Managed server '${spec.id}' did not become healthy before startup timeout`,
                    );
                    snapshot = createSnapshot({
                        ...snapshot,
                        state: 'unhealthy',
                        lastErrorMessage: error.message,
                    });
                    throw error;
                },
                pulseLiveness: () => {
                    if (!disposed && snapshot.state === 'healthy') {
                        pulseLiveness();
                    }
                },
                reapOrphans,
                async dispose() {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    if (watchdogTimer) {
                        clearInterval(watchdogTimer);
                        watchdogTimer = null;
                    }
                    await processHandle?.dispose();
                    await durableLog?.close().catch(() => undefined);
                    snapshot = createSnapshot({
                        ...snapshot,
                        state: 'stopped',
                    });
                },
            });
            params.addDisposable?.(handle);
            return handle;
        },
    });
    return service;
}
