import { createHash, randomUUID } from 'node:crypto';

import type {
    ManagedServerHandle,
    ManagedServerHealthCheck,
    ManagedServerSnapshot,
    ManagedServerSpec,
    ManagedServerStopResult,
    PluginExecService,
    PluginManagedServersService,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import type {
    ManagedServerDurabilityOwner,
    ManagedServerDurableLogCapture,
} from './managedServerDurability';

type ManagedServerScope = Readonly<{
    generation: string;
    pluginId: string;
    contributionId: string;
    isGenerationCurrent(): boolean;
    exec: Pick<PluginExecService, 'spawn' | 'run'>;
}>;

type ManagedServerEntry = {
    readonly generationKey: string;
    readonly qualifiedId: string;
    readonly requestedSpecFingerprint: string;
    readonly lifecycle: AbortController;
    reusable: boolean;
    establishment: Promise<ManagedServerHandle>;
};

export interface StablePluginManagedServersHost {
    bind(scope: ManagedServerScope): PluginManagedServersService;
    retireGeneration(generation: string, pluginId: string): Promise<void>;
}

type ManagedServerEndpoint = Readonly<{
    baseUrl: string;
    host: '127.0.0.1' | '::1';
    port: number;
}>;

const RETIREMENT_FAILURE_CODE = 'plugin_managed_server_retirement_failed';
const MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES = 64 * 1024;
// Host-internal workload guard pending RA21 platform/provider measurement.
const MAX_MANAGED_SERVER_HANDLES_PER_GENERATION = 32;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function isRetirementFailure(error: unknown): boolean {
    return error instanceof PluginError && error.code === RETIREMENT_FAILURE_CODE;
}

function stableJson(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
}

function hostFingerprint(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}

function durableLogSecretValues(spec: ManagedServerSpec): readonly string[] {
    if (spec.mode.kind !== 'managedSpawn') return Object.freeze([]);
    const values = [
        ...(spec.launch?.args ?? []),
        ...Object.values(spec.launch?.env ?? {}),
        ...(spec.mode.credential?.environment ? [spec.mode.credential.environment.value] : []),
        ...(spec.mode.credential?.httpHeader ? [spec.mode.credential.httpHeader.value] : []),
        ...(spec.healthCheck?.kind === 'http' ? Object.values(spec.healthCheck.headers ?? {}) : []),
    ];
    return Object.freeze([...new Set(values.filter((value) => value.length > 0))]);
}

function generationKey(scope: Pick<ManagedServerScope, 'generation' | 'pluginId'>): string {
    return `${scope.pluginId}\u0000${scope.generation}`;
}

function qualifiedId(scope: ManagedServerScope, id: string): string {
    return `${generationKey(scope)}\u0000${scope.contributionId}\u0000${id}`;
}

function normalizeLoopbackHost(host: string): '127.0.0.1' | '::1' {
    if (host === '127.0.0.1' || host === '::1') return host;
    return fail(
        'plugin_managed_server_endpoint_denied',
        'Managed servers must bind or attach to an explicit loopback address',
    );
}

function validatePort(port: number): number {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return fail('plugin_managed_server_endpoint_invalid', 'Managed server port must be between 1 and 65535');
    }
    return port;
}

function parseLoopbackUrl(
    value: string,
    options: Readonly<{ allowSearch?: boolean; allowHash?: boolean }> = {},
): ManagedServerEndpoint {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return fail('plugin_managed_server_endpoint_invalid', 'Managed server base URL is invalid');
    }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
        return fail(
            'plugin_managed_server_endpoint_denied',
            'Managed server endpoints must use credential-free HTTP loopback URLs',
        );
    }
    if ((!options.allowSearch && url.search !== '') || (!options.allowHash && url.hash !== '')) {
        return fail(
            'plugin_managed_server_endpoint_invalid',
            'Managed server base URLs cannot carry query credentials or fragments',
        );
    }
    const host = normalizeLoopbackHost(url.hostname.replace(/^\[|\]$/gu, ''));
    const port = validatePort(url.port === '' ? 80 : Number(url.port));
    return Object.freeze({ baseUrl: url.toString().replace(/\/$/u, ''), host, port });
}

function resolveHealthServerPath(path: string, endpoint: ManagedServerEndpoint): ManagedServerEndpoint {
    if (!path.startsWith('/')) {
        return fail('plugin_managed_server_health_invalid', 'Managed server health path must be absolute');
    }
    const target = parseLoopbackUrl(new URL(path, `${endpoint.baseUrl}/`).toString(), { allowSearch: true });
    if (target.host !== endpoint.host || target.port !== endpoint.port) {
        return fail(
            'plugin_managed_server_endpoint_denied',
            'Managed server health checks must target the supervised loopback endpoint',
        );
    }
    return target;
}

function canonicalHealthCheckFacts(check: ManagedServerHealthCheck): ManagedServerHealthCheck {
    if (check.kind === 'command' || !check.target) return check;
    if (check.target.kind === 'url') {
        return {
            ...check,
            target: { kind: 'url', url: parseLoopbackUrl(check.target.url, { allowSearch: true }).baseUrl },
        };
    }
    const fixtureEndpoint = Object.freeze({
        baseUrl: 'http://127.0.0.1:49152',
        host: '127.0.0.1' as const,
        port: 49_152,
    });
    const canonical = new URL(resolveHealthServerPath(check.target.path, fixtureEndpoint).baseUrl);
    return {
        ...check,
        target: { kind: 'serverPath', path: `${canonical.pathname}${canonical.search}` },
    };
}

function canonicalSpecFacts(spec: ManagedServerSpec): unknown {
    if (spec.startupTimeoutMs !== undefined && (!Number.isSafeInteger(spec.startupTimeoutMs) || spec.startupTimeoutMs < 0)) {
        return fail('plugin_managed_server_timeout_invalid', 'Managed server startup timeout must be a non-negative safe integer');
    }
    if (spec.watchdog && (
        !Number.isSafeInteger(spec.watchdog.intervalMs)
        || spec.watchdog.intervalMs < 1
        || !Number.isSafeInteger(spec.watchdog.missedIntervals)
        || spec.watchdog.missedIntervals < 1
    )) {
        return fail(
            'plugin_managed_server_watchdog_invalid',
            'Managed server watchdog values must be positive safe integers',
        );
    }
    if (spec.healthCheck?.timeoutMs !== undefined && (
        !Number.isSafeInteger(spec.healthCheck.timeoutMs)
        || spec.healthCheck.timeoutMs < 1
    )) {
        return fail(
            'plugin_managed_server_health_timeout_invalid',
            'Managed server health timeout must be a positive safe integer',
        );
    }
    if (spec.mode.kind === 'externalAttach') {
        const endpoint = parseLoopbackUrl(spec.mode.baseUrl);
        return {
            ...spec,
            mode: { ...spec.mode, baseUrl: endpoint.baseUrl },
            ...(spec.healthCheck ? { healthCheck: canonicalHealthCheckFacts(spec.healthCheck) } : {}),
        };
    }
    const host = normalizeLoopbackHost(spec.mode.host ?? '127.0.0.1');
    const port = spec.mode.port === undefined ? null : validatePort(spec.mode.port);
    const baseUrl = spec.mode.baseUrl === undefined ? null : parseLoopbackUrl(spec.mode.baseUrl).baseUrl;
    if (baseUrl !== null) {
        const parsed = parseLoopbackUrl(baseUrl);
        if (parsed.host !== host || (port !== null && parsed.port !== port)) {
            return fail(
                'plugin_managed_server_endpoint_invalid',
                'Managed server base URL must match its selected loopback host and port',
            );
        }
    }
    return {
        ...spec,
        mode: {
            ...spec.mode,
            host,
            port,
            baseUrl,
        },
        ...(spec.healthCheck ? { healthCheck: canonicalHealthCheckFacts(spec.healthCheck) } : {}),
    };
}

function assertSpecId(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        fail('plugin_managed_server_id_invalid', 'Managed server id must be between 1 and 256 code units');
    }
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    if (!signal) return await promise;
    let abort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new PluginError({
            code: 'plugin_managed_server_aborted',
            message: 'Managed server operation was aborted',
        }));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (abort) signal.removeEventListener('abort', abort);
    }
}

function freezeSnapshot(snapshot: ManagedServerSnapshot): ManagedServerSnapshot {
    return Object.freeze({ ...snapshot });
}

function processExitCode(result: PluginProcessResult): string {
    const observed = result.termination.observed;
    if (observed.kind === 'exit') return `exit_${observed.exitCode}`;
    if (observed.kind === 'signal') return 'signal';
    return observed.diagnostic.code;
}

function healthCheckUrl(check: Extract<ManagedServerHealthCheck, { kind: 'http' }>, endpoint: ManagedServerEndpoint): string {
    if (!check.target || check.target.kind === 'serverPath') {
        const path = check.target?.path ?? '/';
        return resolveHealthServerPath(path, endpoint).baseUrl;
    }
    const target = parseLoopbackUrl(check.target.url, { allowSearch: true });
    if (target.host !== endpoint.host || target.port !== endpoint.port) {
        return fail(
            'plugin_managed_server_endpoint_denied',
            'Managed server health checks must target the supervised loopback endpoint',
        );
    }
    return target.baseUrl;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(new PluginError({
                code: 'plugin_managed_server_aborted',
                message: 'Managed server operation was aborted',
            }));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal) {
            void Promise.resolve().then(() => {
                if (signal.aborted) abort();
            });
        }
    });
}

export function createStablePluginManagedServersHost(params: Readonly<{
    fetch?: typeof fetch;
    now?: () => number;
    createInstanceId?: () => string;
    selectPort?: (host: '127.0.0.1' | '::1') => number | Promise<number>;
    maxRetiredGenerationKeys?: number;
    durability?: ManagedServerDurabilityOwner;
    captureProcessStartIdentity?: (pid: number) => Promise<string | null>;
}>): StablePluginManagedServersHost {
    const entries = new Map<string, ManagedServerEntry>();
    const retiredGenerationKeys = new Set<string>();
    const maxRetiredGenerationKeys = params.maxRetiredGenerationKeys ?? 256;
    if (!Number.isSafeInteger(maxRetiredGenerationKeys) || maxRetiredGenerationKeys < 1) {
        fail(
            'plugin_managed_server_retirement_bound_invalid',
            'Managed server retirement tombstone capacity must be a positive safe integer',
        );
    }
    const now = params.now ?? Date.now;
    const fetchImpl = params.fetch ?? globalThis.fetch;
    const createInstanceId = params.createInstanceId ?? randomUUID;
    let reconciliation: Promise<void> | null = null;

    async function reconcileDurableCustody(): Promise<void> {
        if (!params.durability) return;
        reconciliation ??= params.durability.reconcile().then((result) => {
            if (result.failed > 0 || result.corrupt > 0) {
                fail(
                    'plugin_managed_server_recovery_failed',
                    'One or more prior managed server process trees could not be recovered safely',
                );
            }
        }).catch((error: unknown) => {
            if (error instanceof PluginError) throw error;
            fail('plugin_managed_server_recovery_failed', 'Managed server custody recovery failed');
        });
        await reconciliation;
    }

    async function resolveEndpoint(spec: ManagedServerSpec): Promise<ManagedServerEndpoint> {
        if (spec.mode.kind === 'externalAttach') return parseLoopbackUrl(spec.mode.baseUrl);
        const host = normalizeLoopbackHost(spec.mode.host ?? '127.0.0.1');
        if (spec.mode.baseUrl) {
            const endpoint = parseLoopbackUrl(spec.mode.baseUrl);
            if (endpoint.host !== host || (
                spec.mode.port !== undefined
                && endpoint.port !== validatePort(spec.mode.port)
            )) {
                return fail(
                    'plugin_managed_server_endpoint_invalid',
                    'Managed server base URL must match its selected loopback host and port',
                );
            }
            return endpoint;
        }
        const selectedPort = spec.mode.port
            ?? (params.selectPort ? await params.selectPort(host) : fail(
                'plugin_managed_server_port_unavailable',
                'The host cannot select a managed server port',
            ));
        const port = validatePort(selectedPort);
        return Object.freeze({
            host,
            port,
            baseUrl: host === '::1' ? `http://[::1]:${port}` : `http://${host}:${port}`,
        });
    }

    function launchRequest(spec: ManagedServerSpec, endpoint: ManagedServerEndpoint) {
        if (spec.mode.kind !== 'managedSpawn' || !spec.launch) {
            return fail('plugin_managed_server_launch_invalid', 'Managed server launch facts are missing');
        }
        const mode = spec.mode;
        const args = [...(spec.launch.args ?? [])];
        if (mode.portArgument) args.push(mode.portArgument, String(endpoint.port));
        const env = { ...(spec.launch.env ?? {}) };
        if (mode.portEnvironmentKey) env[mode.portEnvironmentKey] = String(endpoint.port);
        if (mode.baseUrlEnvironmentKey) env[mode.baseUrlEnvironmentKey] = endpoint.baseUrl;
        if (mode.credential?.environment) {
            env[mode.credential.environment.name] = mode.credential.environment.value;
        }
        return Object.freeze({
            ...spec.launch,
            maxStdoutBytes: Math.min(
                spec.launch.maxStdoutBytes ?? MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
                MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
            ),
            maxStderrBytes: Math.min(
                spec.launch.maxStderrBytes ?? MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
                MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
            ),
            ...(args.length > 0 ? { args: Object.freeze(args) } : {}),
            ...(Object.keys(env).length > 0 ? { env: Object.freeze(env) } : {}),
        });
    }

    async function establish(
        spec: ManagedServerSpec,
        entry: ManagedServerEntry,
        scope: ManagedServerScope,
    ): Promise<ManagedServerHandle> {
        const endpoint = await waitWithAbort(resolveEndpoint(spec), entry.lifecycle.signal);
        if (spec.healthCheck?.kind === 'http') healthCheckUrl(spec.healthCheck, endpoint);
        const issuedInstanceId = createInstanceId();
        const instanceId = typeof issuedInstanceId === 'string' ? issuedInstanceId.trim() : '';
        if (!instanceId) {
            return fail('plugin_managed_server_identity_failed', 'Host could not issue a managed server identity');
        }

        let process: PluginProcessHandle | null = null;
        let custodyClaimed = false;
        let durableLog: ManagedServerDurableLogCapture | null = null;
        let outputSubscription: Readonly<{ dispose(): void }> | null = null;
        let processTerminal: Readonly<
            | { kind: 'result'; result: PluginProcessResult }
            | { kind: 'failed' }
        > | null = null;
        let cleanupPromise: Promise<void> | null = null;
        let outputDisposed = false;
        let processDisposed = false;
        let logClosed = false;
        const lifecycleProbeController = new AbortController();
        let watchdogTimer: ReturnType<typeof setInterval> | null = null;
        let watchdogInFlight = false;
        let consecutiveHealthMisses = 0;
        let snapshot = freezeSnapshot({
            id: spec.id,
            instanceId,
            state: 'starting',
            mode: spec.mode.kind,
            baseUrl: endpoint.baseUrl,
            port: endpoint.port,
            pid: null,
            startedAtMs: spec.mode.kind === 'managedSpawn' ? now() : null,
            lastHealthyAtMs: null,
        });
        const isStopped = (): boolean => snapshot.state === 'stopped';
        const isStopping = (): boolean => cleanupPromise !== null;
        const isGenerationUsable = (): boolean => {
            try {
                return scope.isGenerationCurrent() && !retiredGenerationKeys.has(entry.generationKey);
            } catch {
                return false;
            }
        };
        const assertGenerationUsable = (): void => {
            if (!isGenerationUsable()) fail('plugin_generation_stale', 'Plugin generation is stale');
        };

        const setUnhealthy = (code: string): void => {
            if (snapshot.state === 'stopped') return;
            snapshot = freezeSnapshot({ ...snapshot, state: 'unhealthy', code });
        };

        async function runBoundedHealthProbe(
            operation: (signal: AbortSignal) => Promise<boolean>,
            signal: AbortSignal | undefined,
            timeoutMs: number,
        ): Promise<boolean> {
            assertNotAborted(signal);
            assertGenerationUsable();
            if (lifecycleProbeController.signal.aborted) return false;
            const controller = new AbortController();
            let rejectForAbort: ((error: PluginError) => void) | null = null;
            const callerAbort = new Promise<never>((_resolve, reject) => {
                rejectForAbort = reject;
            });
            const abort = () => {
                controller.abort();
                rejectForAbort?.(new PluginError({
                    code: 'plugin_managed_server_aborted',
                    message: 'Managed server operation was aborted',
                }));
            };
            signal?.addEventListener('abort', abort, { once: true });
            let resolveForLifecycle: (() => void) | null = null;
            const lifecycleInterrupted = new Promise<false>((resolve) => {
                resolveForLifecycle = () => {
                    controller.abort();
                    resolve(false);
                };
                lifecycleProbeController.signal.addEventListener('abort', resolveForLifecycle, { once: true });
            });
            let timedOut = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const timeoutResult = new Promise<false>((resolve) => {
                timeout = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    resolve(false);
                }, Math.max(1, timeoutMs));
                timeout.unref?.();
            });
            try {
                return await Promise.race([
                    operation(controller.signal),
                    timeoutResult,
                    callerAbort,
                    lifecycleInterrupted,
                ]);
            } catch (error) {
                if (signal?.aborted) {
                    return fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
                }
                if (timedOut) return false;
                throw error;
            } finally {
                if (timeout) clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                if (resolveForLifecycle) {
                    lifecycleProbeController.signal.removeEventListener('abort', resolveForLifecycle);
                }
            }
        }

        async function checkHealth(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
            assertNotAborted(signal);
            assertGenerationUsable();
            const healthCheck = spec.healthCheck;
            if (!healthCheck) return true;
            if (healthCheck.kind === 'command') {
                return await runBoundedHealthProbe(async (probeSignal) => {
                    const result = await scope.exec.run({
                        executable: healthCheck.executable,
                        args: healthCheck.args,
                        timeoutMs,
                    }, { signal: probeSignal });
                    return result.termination.observed.kind === 'exit'
                        && result.termination.observed.exitCode === 0;
                }, signal, timeoutMs);
            }
            return await runBoundedHealthProbe(async (probeSignal) => {
                const response = await fetchImpl(healthCheckUrl(healthCheck, endpoint), {
                    method: 'GET',
                    headers: healthCheck.headers,
                    redirect: 'manual',
                    signal: probeSignal,
                });
                return response.ok;
            }, signal, timeoutMs);
        }

        async function watchdogTick(): Promise<void> {
            if (watchdogInFlight || isStopped() || processTerminal) return;
            if (!isGenerationUsable()) {
                if (watchdogTimer) {
                    clearInterval(watchdogTimer);
                    watchdogTimer = null;
                }
                return;
            }
            watchdogInFlight = true;
            try {
                const timeoutMs = spec.healthCheck?.timeoutMs ?? spec.watchdog?.intervalMs ?? 1;
                if (await checkHealth(undefined, timeoutMs)) {
                    consecutiveHealthMisses = 0;
                    if (!isStopped() && !processTerminal && isGenerationUsable()) {
                        snapshot = freezeSnapshot({
                            ...snapshot,
                            state: 'healthy',
                            lastHealthyAtMs: now(),
                            code: undefined,
                        });
                    }
                    return;
                }
            } catch {
                // A failed probe is one missed interval; the bounded watchdog decides terminal health truth.
            } finally {
                watchdogInFlight = false;
            }
            if (isStopped() || processTerminal || !isGenerationUsable()) return;
            consecutiveHealthMisses += 1;
            if (consecutiveHealthMisses >= (spec.watchdog?.missedIntervals ?? 1)) {
                setUnhealthy('plugin_managed_server_watchdog_unhealthy');
            }
        }

        function startWatchdog(): void {
            if (!spec.watchdog || watchdogTimer || !spec.healthCheck) return;
            const intervalMs = Math.max(1, spec.watchdog.intervalMs);
            watchdogTimer = setInterval(() => { void watchdogTick(); }, intervalMs);
            watchdogTimer.unref?.();
        }

        function stopWatchdog(): void {
            if (!watchdogTimer) return;
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }

        async function cleanup(): Promise<void> {
            if (!cleanupPromise) {
                entry.reusable = false;
                lifecycleProbeController.abort();
                stopWatchdog();
                const attempt = (async () => {
                    const failures: unknown[] = [];
                    if (!outputDisposed) {
                        try {
                            outputSubscription?.dispose();
                            outputDisposed = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (!processDisposed) {
                        try {
                            await process?.dispose();
                            processDisposed = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (!logClosed) {
                        try {
                            await durableLog?.close();
                            logClosed = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (custodyClaimed && processDisposed) {
                        try {
                            await params.durability?.release(instanceId);
                            custodyClaimed = false;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (processDisposed) {
                        snapshot = freezeSnapshot({ ...snapshot, state: 'stopped', code: undefined });
                    }
                    if (failures.length > 0) {
                        fail(
                            'plugin_managed_server_cleanup_failed',
                            'Managed server cleanup did not complete safely',
                        );
                    }
                })();
                cleanupPromise = attempt;
                try {
                    await attempt;
                    if (entries.get(entry.qualifiedId) === entry) entries.delete(entry.qualifiedId);
                } finally {
                    if (cleanupPromise === attempt) cleanupPromise = null;
                }
                return;
            }
            await cleanupPromise;
        }

        if (spec.mode.kind === 'managedSpawn') {
            await reconcileDurableCustody();
            process = await scope.exec.spawn(launchRequest(spec, endpoint), { signal: entry.lifecycle.signal });
            if (entry.lifecycle.signal.aborted) {
                try {
                    await process.dispose();
                } catch {
                    throw new PluginError({
                        code: RETIREMENT_FAILURE_CODE,
                        message: 'Managed server process launched after retirement and could not be disposed',
                    });
                }
                return fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
            }
            snapshot = freezeSnapshot({ ...snapshot, pid: process.pid });
            if (params.durability) {
                try {
                    const pid = process.pid;
                    const processStartIdentity = pid === null || !params.captureProcessStartIdentity
                        ? null
                        : await params.captureProcessStartIdentity(pid);
                    if (pid === null || !processStartIdentity) {
                        fail(
                            'plugin_managed_server_custody_failed',
                            'Managed server process identity could not be captured safely',
                        );
                    }
                    await params.durability.claim(Object.freeze({
                        v: 1,
                        instanceId,
                        generationFingerprint: hostFingerprint({
                            generation: scope.generation,
                            pluginId: scope.pluginId,
                        }),
                        serverFingerprint: entry.requestedSpecFingerprint,
                        pid,
                        processStartIdentity,
                        endpoint: Object.freeze({ host: endpoint.host, port: endpoint.port }),
                        createdAtMs: snapshot.startedAtMs ?? now(),
                    }));
                    custodyClaimed = true;
                    if (spec.durableLog?.enabled) {
                        durableLog = await params.durability.openLog({
                            instanceId,
                            serverId: spec.id,
                            keepCount: spec.durableLog.keepCount,
                            secretValues: durableLogSecretValues(spec),
                            nowMs: snapshot.startedAtMs ?? now(),
                        });
                        outputSubscription = process.onOutput((chunk) => {
                            durableLog?.write(chunk.stream, chunk.data);
                        });
                    }
                } catch (error) {
                    outputSubscription?.dispose();
                    try {
                        await process.dispose();
                        await durableLog?.close();
                        if (custodyClaimed) {
                            await params.durability.release(instanceId);
                            custodyClaimed = false;
                        }
                    } catch {
                        throw new PluginError({
                            code: RETIREMENT_FAILURE_CODE,
                            message: 'Managed server custody failed and its process tree could not be disposed',
                        });
                    }
                    if (error instanceof PluginError && error.code === 'plugin_managed_server_custody_failed') {
                        throw error;
                    }
                    fail('plugin_managed_server_custody_failed', 'Managed server custody could not be established');
                }
            }
            void process.wait().then((result) => {
                processTerminal = Object.freeze({ kind: 'result', result });
                entry.reusable = false;
                lifecycleProbeController.abort();
                stopWatchdog();
                setUnhealthy('plugin_managed_server_process_exited');
            }).catch(() => {
                processTerminal = Object.freeze({ kind: 'failed' });
                entry.reusable = false;
                lifecycleProbeController.abort();
                stopWatchdog();
                setUnhealthy('plugin_managed_server_process_failed');
            });
        }

        const handle: ManagedServerHandle = Object.freeze({
            snapshot: () => snapshot,
            async waitUntilHealthy(options?: { timeoutMs?: number; signal?: AbortSignal }) {
                const timeoutMs = options?.timeoutMs ?? spec.startupTimeoutMs ?? 30_000;
                if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
                    return fail(
                        'plugin_managed_server_timeout_invalid',
                        'Managed server health deadline must be a non-negative safe integer',
                    );
                }
                const deadline = now() + Math.max(0, timeoutMs);
                while (now() <= deadline) {
                    assertNotAborted(options?.signal);
                    assertGenerationUsable();
                    if (isStopping() || isStopped()) {
                        return fail('plugin_managed_server_stopped', 'Managed server handle is stopped');
                    }
                    const terminalBeforeCheck = processTerminal;
                    if (terminalBeforeCheck) {
                        if (terminalBeforeCheck.kind === 'failed') {
                            return fail(
                                'plugin_managed_server_process_failed',
                                'Managed server process observation failed',
                            );
                        }
                        return fail(
                            'plugin_managed_server_process_exited',
                            `Managed server process exited (${processExitCode(terminalBeforeCheck.result)})`,
                        );
                    }
                    let healthy = false;
                    const remainingMs = Math.max(0, deadline - now());
                    try {
                        healthy = await checkHealth(
                            options?.signal,
                            Math.max(1, Math.min(spec.healthCheck?.timeoutMs ?? remainingMs, remainingMs)),
                        );
                    } catch (error) {
                        if (error instanceof PluginError) throw error;
                    }
                    assertGenerationUsable();
                    const terminalAfterCheck = processTerminal;
                    if (terminalAfterCheck) {
                        if (terminalAfterCheck.kind === 'failed') {
                            setUnhealthy('plugin_managed_server_process_failed');
                            return fail(
                                'plugin_managed_server_process_failed',
                                'Managed server process observation failed',
                            );
                        }
                        setUnhealthy('plugin_managed_server_process_exited');
                        return fail(
                            'plugin_managed_server_process_exited',
                            `Managed server process exited (${processExitCode(terminalAfterCheck.result)})`,
                        );
                    }
                    if (isStopping() || isStopped()) {
                        return fail('plugin_managed_server_stopped', 'Managed server handle is stopped');
                    }
                    if (healthy) {
                        snapshot = freezeSnapshot({
                            ...snapshot,
                            state: 'healthy',
                            lastHealthyAtMs: now(),
                            code: undefined,
                        });
                        startWatchdog();
                        return snapshot;
                    }
                    if (now() >= deadline) break;
                    await delay(Math.min(25, Math.max(1, deadline - now())), options?.signal);
                }
                setUnhealthy('plugin_managed_server_health_timeout');
                return fail(
                    'plugin_managed_server_health_timeout',
                    'Managed server did not become healthy before its startup timeout',
                );
            },
            async stop(options?: { signal?: AbortSignal }): Promise<ManagedServerStopResult> {
                assertNotAborted(options?.signal);
                await waitWithAbort(cleanup(), options?.signal);
                return Object.freeze({ status: spec.mode.kind === 'managedSpawn' ? 'stopped' : 'detached' });
            },
            async dispose(): Promise<void> {
                await cleanup();
            },
        });

        if (!spec.healthCheck) {
            snapshot = freezeSnapshot({ ...snapshot, state: 'healthy', lastHealthyAtMs: now() });
            startWatchdog();
        }
        return handle;
    }

    function bind(scope: ManagedServerScope): PluginManagedServersService {
        const scopeGenerationKey = generationKey(scope);
        return Object.freeze({
            async supervise(spec: ManagedServerSpec, options?: { signal?: AbortSignal }) {
                if (!scope.isGenerationCurrent() || retiredGenerationKeys.has(scopeGenerationKey)) {
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
                assertNotAborted(options?.signal);
                assertSpecId(spec.id);
                const fingerprint = hostFingerprint(canonicalSpecFacts(spec));
                const id = qualifiedId(scope, spec.id);
                const existing = entries.get(id);
                if (existing) {
                    if (existing.requestedSpecFingerprint !== fingerprint) {
                        return fail(
                            'plugin_managed_server_spec_conflict',
                            'A different managed server specification already owns this generation-qualified id',
                        );
                    }
                    if (!existing.reusable) {
                        return fail(
                            'plugin_managed_server_not_reusable',
                            'Managed server handle is stopping, stopped, or terminal and cannot be reused',
                        );
                    }
                    return await waitWithAbort(existing.establishment, options?.signal);
                }
                const retained = [...entries.values()].filter((entry) => entry.generationKey === scopeGenerationKey).length;
                if (retained >= MAX_MANAGED_SERVER_HANDLES_PER_GENERATION) {
                    return fail(
                        'plugin_managed_server_capacity_exceeded',
                        `A plugin generation may retain at most ${MAX_MANAGED_SERVER_HANDLES_PER_GENERATION} managed server handles`,
                    );
                }
                const entry: ManagedServerEntry = {
                    generationKey: scopeGenerationKey,
                    qualifiedId: id,
                    requestedSpecFingerprint: fingerprint,
                    lifecycle: new AbortController(),
                    reusable: true,
                    establishment: Promise.resolve(null as never),
                };
                entry.establishment = establish(spec, entry, scope).catch((error) => {
                    if (!isRetirementFailure(error) && entries.get(id) === entry) entries.delete(id);
                    throw error;
                });
                entries.set(id, entry);
                return await waitWithAbort(entry.establishment, options?.signal);
            },
        });
    }

    return Object.freeze({
        bind,
        async retireGeneration(generation: string, pluginId: string) {
            const key = generationKey({ generation, pluginId });
            retiredGenerationKeys.delete(key);
            retiredGenerationKeys.add(key);
            while (retiredGenerationKeys.size > maxRetiredGenerationKeys) {
                const oldest = retiredGenerationKeys.values().next().value as string | undefined;
                if (oldest === undefined) break;
                retiredGenerationKeys.delete(oldest);
            }
            const retiringEntries = [...entries.values()].filter((entry) => entry.generationKey === key);
            for (const entry of retiringEntries) {
                entry.reusable = false;
                entry.lifecycle.abort();
            }
            const establishments = await Promise.allSettled(retiringEntries
                .map(async (entry) => await entry.establishment));
            const handles = establishments.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
            const disposals = await Promise.allSettled(handles.map(async (handle) => await handle.dispose()));
            const establishmentCleanupFailed = establishments.some(
                (result) => result.status === 'rejected' && isRetirementFailure(result.reason),
            );
            if (establishmentCleanupFailed || disposals.some((result) => result.status === 'rejected')) {
                fail(
                    RETIREMENT_FAILURE_CODE,
                    'One or more managed server handles could not be retired cleanly',
                );
            }
        },
    });
}
