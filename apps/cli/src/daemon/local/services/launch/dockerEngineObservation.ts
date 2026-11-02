import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';

import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';

type Subscription = Readonly<{ dispose(): Promise<void> }>;
export type DockerEngineEventSource = (request: Readonly<{
    event(value: unknown): void;
    disconnected(): void;
    signal: AbortSignal;
}>) => Promise<Subscription>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Docker's own transport resolves Unix sockets, named pipes, TLS and contexts.
 * Unlike `docker events`, the HTTP response proves subscription before reconcile.
 * Contract: docker/cli cli/command/system/dial_stdio.go (Docker 29), Engine GET /events.
 */
export function openDockerEngineEvents(launch: HostAuthorizedPluginExecLaunch, prefix: readonly string[]): DockerEngineEventSource {
    return async ({ event, disconnected, signal }) => {
        signal.throwIfAborted();
        const process = spawnAuthorizedHostExecLaunchForHost({ command: launch.command,
            args: [...prefix, 'system', 'dial-stdio'], cwd: launch.cwd, env: launch.env,
            // Event payloads are consumed below, never retained as command diagnostics.
            maxStdoutBytes: 0, maxStderrBytes: 0, release() {} }, { signal });
        const socket = Duplex.from({ readable: process.child.stdout, writable: process.child.stdin });
        let closed = false;
        let disposing: Promise<void> | undefined;
        let lines: ReturnType<typeof createInterface> | undefined;
        const request = httpRequest({ method: 'GET', host: 'docker',
            path: `/events?filters=${encodeURIComponent(JSON.stringify({ type: ['container'] }))}`,
            createConnection: () => socket });
        const dispose = () => disposing ??= (async () => {
            closed = true;
            lines?.close();
            request.destroy();
            socket.destroy();
            await process.handle.dispose();
        })();
        const onAbort = () => { void dispose().catch(() => {}); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            await new Promise<void>((resolve, reject) => {
                request.once('error', reject);
                void process.handle.wait().then(() => reject(new Error('docker_events_disconnected')), reject);
                request.once('response', response => {
                    if (response.statusCode !== 200) { response.resume(); reject(new Error('docker_events_unavailable')); return; }
                    lines = createInterface({ input: response, crlfDelay: Infinity });
                    lines.on('line', line => {
                        try { event(JSON.parse(line)); }
                        catch { if (!closed) disconnected(); }
                    });
                    response.once('error', () => { if (!closed) disconnected(); });
                    response.once('end', () => { if (!closed) disconnected(); });
                    request.on('error', () => { if (!closed) disconnected(); });
                    void process.handle.wait().then(() => { if (!closed) disconnected(); }, () => { if (!closed) disconnected(); });
                    resolve();
                });
                request.end();
            });
            signal.throwIfAborted();
            return { async dispose() { signal.removeEventListener('abort', onAbort); await dispose(); } };
        } catch (error) {
            signal.removeEventListener('abort', onAbort);
            await dispose();
            throw error;
        }
    };
}

type Registration = Readonly<{
    ids: readonly string[];
    events: DockerEngineEventSource;
    inspect(ids: readonly string[], signal: AbortSignal): Promise<readonly unknown[] | null>;
    /** Derive the one safe comparison fact before raw Config/HostConfig are discarded. */
    configurationMatches?(container: unknown): boolean | undefined;
    changed(rows: readonly unknown[] | null): void;
}>;

type Engine = ReturnType<typeof createEngine>;
const engines = new Map<string, Engine>();

/** Existing live/settling observation custody, not configured Docker contexts. */
export function readObservedDockerEngineIds(): readonly string[] {
    return [...engines.keys()];
}

/** One connection, changed-id batch and outage-only recovery owner per actual engine. */
export function observeDockerEngine(engineId: string, registration: Registration) {
    let engine = engines.get(engineId);
    if (!engine) {
        engine = createEngine(() => engines.delete(engineId));
        engines.set(engineId, engine);
    }
    return engine.add(registration);
}

function createEngine(retired: () => void) {
    const registrations = new Map<Registration, { ready(): void; value?: string; waiting: Set<() => void> }>();
    const byContainer = new Map<string, Set<Registration>>();
    const pending = new Set<string>();
    let stream: Subscription | undefined;
    let streamSource: Registration | undefined;
    let closing = Promise.resolve();
    let connection: AbortController | undefined;
    let connecting: Promise<void> | undefined;
    let connectingSource: Registration | undefined;
    let recovery: ReturnType<typeof setInterval> | undefined;
    let reconciling: Promise<void> | undefined;
    let inspectingSource: Registration | undefined;
    let scheduled = false;
    let closed = false;
    const publish = (registration: Registration, rows: readonly unknown[] | null) => {
        const retained = registrations.get(registration);
        if (!retained) return;
        const value = JSON.stringify(rows);
        if (value !== retained.value) { retained.value = value; registration.changed(rows); }
        retained.ready();
    };
    const stopRecovery = () => { if (recovery) clearInterval(recovery); recovery = undefined; };
    const down = () => {
        if (closed) return;
        connection?.abort();
        connection = undefined;
        const previous = stream;
        const previousSource = streamSource;
        stream = undefined;
        if (previous) {
            closing = closing.then(async () => {
                await previous.dispose();
                if (streamSource === previousSource) streamSource = undefined;
            });
            // Reconnect and final disposal still observe this settlement result.
            void closing.catch(() => {});
        }
        pending.clear();
        for (const [registration, retained] of registrations) {
            publish(registration, null);
            for (const resolve of retained.waiting) resolve();
            retained.waiting.clear();
        }
        // Push cannot serve while disconnected; reuse the incumbent health cadence.
        if (!recovery && registrations.size) {
            recovery = setInterval(() => { void connect(); }, MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue);
            recovery.unref?.();
        }
    };
    const schedule = () => {
        if (scheduled || reconciling || !stream || closed || !pending.size) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            if (!stream || closed || !pending.size) return;
            const ids = [...pending];
            pending.clear();
            const current = connection;
            const source = registrations.keys().next().value;
            if (!source || !current) return;
            inspectingSource = source;
            const affected = new Set(ids.flatMap(id => [...(byContainer.get(id) ?? [])]));
            const requested = [...affected].flatMap(registration => {
                const retained = registrations.get(registration);
                const waiting = [...(retained?.waiting ?? [])];
                retained?.waiting.clear();
                return waiting;
            });
            reconciling = (async () => {
                try {
                    const rows = await source.inspect(ids, current.signal);
                    if (current !== connection || closed) return;
                    if (!rows) { down(); return; }
                    const byId = new Map(rows.flatMap(row => {
                        if (!record(row) || typeof row.Id !== 'string') return [];
                        // Retain only observed service facts, never image env or
                        // unrelated inspect output (which may contain secrets).
                        const config = record(row.Config) ? row.Config : {};
                        const labels = record(config.Labels) ? config.Labels : {};
                        const network = record(row.NetworkSettings) ? row.NetworkSettings : {};
                        const state = record(row.State) ? row.State : {};
                        const host = record(row.HostConfig) ? row.HostConfig : {};
                        const policy = record(host.RestartPolicy) ? host.RestartPolicy : {};
                        return [[row.Id, { native: row, facts: { Id: row.Id,
                            ...(typeof row.Name === 'string' ? { Name: row.Name } : {}),
                            ...(typeof row.Image === 'string' && /^sha256:[a-f0-9]{64}$/u.test(row.Image) ? { Image: row.Image } : {}),
                            Config: { Labels: {
                            'com.docker.compose.project': labels['com.docker.compose.project'],
                            'com.docker.compose.service': labels['com.docker.compose.service'],
                        } }, State: { Status: state.Status, Pid: state.Pid,
                            ...(record(state.Health) ? { Health: { Status: state.Health.Status } } : {}) },
                        NetworkSettings: { Ports: network.Ports,
                            ...(record(network.Networks) ? { Networks: Object.fromEntries(Object.keys(network.Networks).map(name => [name, {}])) } : {}) },
                        RestartCount: row.RestartCount,
                        HostConfig: { RestartPolicy: { Name: policy.Name, MaximumRetryCount: policy.MaximumRetryCount } } } }] as const];
                    }));
                    for (const registration of affected) {
                        publish(registration, registration.ids.flatMap(id => {
                            const observed = byId.get(id);
                            if (!observed) return [];
                            const configurationMatches = registration.configurationMatches?.(observed.native);
                            return [{ ...observed.facts, ...(configurationMatches === undefined ? {} : { configurationMatches }) }];
                        }));
                    }
                } catch { if (current === connection) down(); }
            })().finally(() => { for (const resolve of requested) resolve(); inspectingSource = undefined; reconciling = undefined; schedule(); });
        });
    };
    const event = (value: unknown) => {
        if (!record(value) || value.Type !== 'container' || !record(value.Actor) || typeof value.Actor.ID !== 'string'
            || typeof value.Action !== 'string') return;
        // These native events can change health/lifetime/ports. Exec/attach/log
        // traffic is unrelated to service observation and must not cause inspect.
        if (!['start', 'stop', 'die', 'kill', 'restart', 'pause', 'unpause', 'destroy', 'update', 'rename'].includes(value.Action)
            && !value.Action.startsWith('health_status:')) return;
        const affected = byContainer.get(value.Actor.ID);
        if (!affected) return;
        for (const registration of affected) {
            // Do not hide die/restart behind a later running inspect.
            if (['die', 'restart', 'destroy'].includes(value.Action)) publish(registration, null);
            for (const id of registration.ids) pending.add(id);
        }
        schedule();
    };
    const connect = () => {
        if (closed || connecting || stream || !registrations.size) return connecting;
        connecting = (async () => {
            try {
                await closing;
                if (closed || !registrations.size) return;
                const source = registrations.keys().next().value;
                if (!source) return;
                connectingSource = source;
                const current = new AbortController();
                connection = current;
                const subscribed = await source.events({ event(value) { if (current === connection) event(value); },
                    disconnected() { if (current === connection) down(); }, signal: current.signal });
                if (current.signal.aborted || closed) { await subscribed.dispose(); return; }
                stream = subscribed;
                streamSource = source;
                stopRecovery();
                for (const registration of registrations.keys()) for (const id of registration.ids) pending.add(id);
                schedule();
            } catch { if (!closed) down(); }
        })().finally(() => { connectingSource = undefined; connecting = undefined; });
        return connecting;
    };
    return {
        add(registration: Registration) {
            let ready!: () => void;
            const initial = new Promise<void>(resolve => { ready = resolve; });
            const retained = { ready, waiting: new Set<() => void>() };
            registrations.set(registration, retained);
            for (const id of registration.ids) {
                pending.add(id);
                const readers = byContainer.get(id) ?? new Set<Registration>();
                readers.add(registration);
                byContainer.set(id, readers);
            }
            if (closed) void closing.catch(() => publish(registration, null));
            else if (stream) schedule();
            else if (!recovery) void connect();
            else publish(registration, null);
            let disposed = false;
            let disposal: Promise<void> | undefined;
            return { ready: initial, async refresh() {
                if (disposed || !stream) return;
                const refreshed = new Promise<void>(resolve => { retained.waiting.add(resolve); });
                for (const id of registration.ids) pending.add(id);
                schedule();
                await refreshed;
            }, dispose() { return disposal ??= (async () => {
                disposed = true;
                registrations.delete(registration);
                for (const resolve of retained.waiting) resolve();
                retained.waiting.clear();
                for (const id of registration.ids) {
                    const readers = byContainer.get(id);
                    readers?.delete(registration);
                    if (!readers?.size) { byContainer.delete(id); pending.delete(id); }
                }
                ready();
                if (registrations.size) {
                    // The selected capture retains its native launch/env custody
                    // until its dispatched native work has physically settled.
                    await Promise.all([inspectingSource === registration ? reconciling : undefined,
                        connectingSource === registration ? connecting : undefined]);
                    if (streamSource === registration) {
                        // A shared stream still borrows its source capture's launch
                        // and environment. Stop it before releasing that capture,
                        // then let a surviving registration supply the same owner.
                        down();
                        await Promise.all([closing, reconciling]);
                        if (registrations.size) {
                            await connect();
                            await reconciling;
                        }
                    }
                    return;
                }
                if (!closed) {
                    closed = true;
                    connection?.abort();
                    connection = undefined;
                    stopRecovery();
                    const previous = stream;
                    stream = undefined;
                    // Keep this same engine owner in the map until native teardown
                    // settles. An unrelated Project can join while its predecessor
                    // is closing, but cannot open a second engine stream.
                    closing = Promise.all([closing, connecting, previous?.dispose(), reconciling]).then(() => {
                        streamSource = undefined;
                        closed = false;
                        if (registrations.size) void connect();
                        else retired();
                    });
                    void closing.catch(() => {
                        for (const current of registrations.keys()) publish(current, null);
                    });
                }
                await closing;
            })(); } };
        },
    };
}
