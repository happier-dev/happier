import { connect as netConnect } from 'node:net';

import { resolveManagedLocalServiceHealthTarget } from './health';

/**
 * Daemon-internal health monitor (refinement 2 of FP-LSV-MANAGED-1).
 *
 * Layers a real monitor LOOP on top of `resolveManagedLocalServiceHealthTarget` (which only
 * forms the loopback URL today). Modeled on the reference script health monitor:
 *  - grace period: do not probe a route younger than `graceMs`,
 *  - failure threshold: flip to `unhealthy` only after `failuresBeforeUnhealthy` consecutive
 *    failed probes (a single transient blip stays `running`); recover to `running` on success,
 *  - single-flight: per-service in-flight guard so ticks never overlap,
 *  - change-only emission: only call back when the health state actually transitions,
 *  - prune-on-stop: drop a service's monitor state when it leaves the running set.
 *
 * The probe default is a binary-safe loopback TCP-connect; an HTTP GET
 * against the resolved health URL is used only when the declaration supplies `healthCheck.path`.
 * No second timer and no Express mount — the runtime ticks this from the existing inventory loop.
 */

export type ManagedHealthCheckSpec =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'http'; path?: string; timeoutMs?: number }>
    | Readonly<{ kind: 'command'; timeoutMs?: number }>;

export type ManagedHealthMonitorService = Readonly<{
    serviceKey: string;
    runId: number;
    pid: number;
    host: string;
    port: number;
    startedAt: number;
    healthCheck: ManagedHealthCheckSpec;
}>;

export type ManagedHealthTransition = Readonly<{
    serviceKey: string;
    runId: number;
    pid: number;
    phase: 'running' | 'unhealthy';
}>;

export type ManagedHealthMonitorOptions = Readonly<{
    now: () => number;
    graceMs?: number;
    failuresBeforeUnhealthy?: number;
    defaultProbeTimeoutMs?: number;
    /** Override the probe (tests inject a deterministic probe). Resolves true when healthy. */
    probe?: (input: Readonly<{ host: string; port: number; path?: string; timeoutMs: number }>) => Promise<boolean>;
    /** Called only when a service's health phase actually transitions. */
    onTransition: (transition: ManagedHealthTransition) => void;
}>;

type MonitorEntry = {
    runId: number;
    pid: number;
    startedAt: number;
    consecutiveFailures: number;
    healthy: boolean;
    inFlight: boolean;
};

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_FAILURES_BEFORE_UNHEALTHY = 2;
const DEFAULT_PROBE_TIMEOUT_MS = 500;

async function loopbackTcpProbe(input: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (result: boolean): void => {
            if (settled) return;
            settled = true;
            try {
                socket.destroy();
            } catch {
                // ignore teardown errors — the result already settled
            }
            resolve(result);
        };
        const socket = netConnect({ host: input.host, port: input.port });
        socket.setTimeout(Math.max(1, input.timeoutMs));
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

export type ManagedHealthMonitor = Readonly<{
    /** Reconcile against the current running set + run one probe pass. Awaitable for tests. */
    tick(services: readonly ManagedHealthMonitorService[]): Promise<void>;
    /** Drop a service's monitor state immediately (on stop/exit). */
    prune(serviceKey: string): void;
    /** Number of tracked services (for tests). */
    size(): number;
}>;

export function createManagedHealthMonitor(options: ManagedHealthMonitorOptions): ManagedHealthMonitor {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const failuresBeforeUnhealthy = Math.max(1, options.failuresBeforeUnhealthy ?? DEFAULT_FAILURES_BEFORE_UNHEALTHY);
    const defaultProbeTimeoutMs = options.defaultProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const probe = options.probe ?? (async (input) => {
        if (input.path !== undefined) {
            // HTTP GET against the resolved loopback URL when a path is declared.
            const target = resolveManagedLocalServiceHealthTarget({ host: input.host, port: input.port, path: input.path });
            if (!target.ok) return false;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
                try {
                    const response = await fetch(target.url, { method: 'GET', signal: controller.signal });
                    return response.ok;
                } finally {
                    clearTimeout(timer);
                }
            } catch {
                return false;
            }
        }
        return await loopbackTcpProbe({ host: input.host, port: input.port, timeoutMs: input.timeoutMs });
    });

    const entries = new Map<string, MonitorEntry>();

    const prune = (serviceKey: string): void => {
        entries.delete(serviceKey);
    };

    const probeService = async (service: ManagedHealthMonitorService, entry: MonitorEntry): Promise<void> => {
        if (entry.inFlight) return;
        if (options.now() - service.startedAt < graceMs) return; // grace period
        const target = resolveManagedLocalServiceHealthTarget({
            host: service.host,
            port: service.port,
            path: service.healthCheck.kind === 'http' ? (service.healthCheck.path ?? '/') : '/',
        });
        if (!target.ok) return; // non-loopback target is never probed (typed reason already from helper)
        entry.inFlight = true;
        try {
            const timeoutMs = service.healthCheck.kind === 'http'
                ? (service.healthCheck.timeoutMs ?? defaultProbeTimeoutMs)
                : defaultProbeTimeoutMs;
            const probeInput = service.healthCheck.kind === 'http' && service.healthCheck.path !== undefined
                ? { host: service.host, port: service.port, path: service.healthCheck.path, timeoutMs }
                : { host: service.host, port: service.port, timeoutMs };
            const healthy = await probe(probeInput);
            if (healthy) {
                entry.consecutiveFailures = 0;
                if (!entry.healthy) {
                    entry.healthy = true;
                    options.onTransition({
                        serviceKey: service.serviceKey,
                        runId: entry.runId,
                        pid: entry.pid,
                        phase: 'running',
                    });
                }
                return;
            }
            entry.consecutiveFailures += 1;
            if (entry.healthy && entry.consecutiveFailures >= failuresBeforeUnhealthy) {
                entry.healthy = false;
                options.onTransition({
                    serviceKey: service.serviceKey,
                    runId: entry.runId,
                    pid: entry.pid,
                    phase: 'unhealthy',
                });
            }
        } finally {
            entry.inFlight = false;
        }
    };

    return {
        async tick(services) {
            const live = new Set(services.map((service) => service.serviceKey));
            for (const key of [...entries.keys()]) {
                if (!live.has(key)) entries.delete(key); // prune services that left the running set
            }
            const probes: Promise<void>[] = [];
            for (const service of services) {
                if (service.healthCheck.kind !== 'http') continue; // only http health is monitored
                const existing = entries.get(service.serviceKey);
                // A new run resets the entry even if the operating system reuses the PID.
                const entry: MonitorEntry = existing
                    && existing.runId === service.runId
                    && existing.pid === service.pid
                    ? existing
                    : {
                        runId: service.runId,
                        pid: service.pid,
                        startedAt: service.startedAt,
                        consecutiveFailures: 0,
                        healthy: true,
                        inFlight: false,
                    };
                entries.set(service.serviceKey, entry);
                probes.push(probeService(service, entry));
            }
            await Promise.all(probes);
        },
        prune,
        size() {
            return entries.size;
        },
    };
}
