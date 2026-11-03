import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';
import { createHealthCheckSourceAdapter } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import type { AccountKvEntry, AccountKvService } from '@happier-dev/plugin-sdk/storage';
import type { HealthCheckResultV1, HealthCheckSourceConfigV1, JsonValue } from '@happier-dev/plugin-sdk';
import { readHeartbeatHealthCheckV1 } from './finiteHeartbeatHealthCheck';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

const materialization = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
const source: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
    checks: [{ checkId: 'http', kind: { pluginId: materialization.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'https://example.test/private-path', expectStatus: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 }] };
const definition: PluginCheckpointedEventSourceDefinitionV1 = {
    automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'health-trigger', triggerRevision: 1,
    sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: materialization.pluginId, localId: 'health-status' },
    sourceInstanceId: 'health:service', sourceContractVersion: 1, sourceConfig: source,
    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null,
};
const result = (status: HealthCheckResultV1['status'], observedAt: number): HealthCheckResultV1 => ({ status, observedAt,
    evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'http' }, author: { kind: 'process' }, text: '{"reason":"http_status"}' }] } });

function fixture(healthSource: HealthCheckSourceConfigV1 = source, events = ['health-status']) {
    let configuredSource = healthSource;
    let now = 1000;
    let status: HealthCheckResultV1['status'] = 'down';
    let safe = true;
    let active = true;
    let watcher = materialization;
    let revision = 1;
    const rows = new Map<string, AccountKvEntry>();
    const writes: JsonValue[] = [];
    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
    const hostListeners = new Map<string, Set<(event: { payload: JsonValue }) => void | Promise<void>>>();
    const sourceReports = new Set<() => void>();
    const kv = {
        async get(key: string) { return rows.get(key) ?? null; },
        async set(key: string, value: JsonValue, options: { expectedVersion: number | 'absent' }) {
            const previous = rows.get(key);
            if ((previous?.version ?? 'absent') !== options.expectedVersion) throw new Error('CAS conflict');
            const version = (previous?.version ?? 0) + 1;
            rows.set(key, { version, value }); writes.push(value); return { version };
        },
    };
    const read = vi.fn(async () => [{ checkId: 'http', result: result(status, now) }]);
    const execute = vi.fn(async (id: string, input: unknown) => {
        if (id === 'automation.event.sources.list') return { kind: 'page', revision: String(revision),
            definitions: active ? events.map((localId, index) => ({ ...definition, triggerId: `health-trigger-${index}`,
                eventRef: { ...definition.eventRef, localId }, sourceConfig: configuredSource,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: watcher } })) : [], nextCursor: null };
        if (id === 'automation.event.source.status.report') {
            if (input && typeof input === 'object' && 'kind' in input && input.kind === 'source') {
                for (const listener of sourceReports) listener();
            }
            return { kind: 'reported' };
        }
        if (id === 'automation.event.admit') {
            const request = AutomationEventAdmitInputV1Schema.parse(input); admissions.push(request);
            return { results: safe ? request.definitions.map(() => ({ kind: 'admitted', checkpointSafe: true, runId: 'run-1' })) : [] };
        }
        throw new Error(`Unexpected host Action ${id}`);
    });
    // SDK host Actions, Account KV and finite health reads are genuine plugin
    // boundaries; the source adapter and SDK admission/runner remain real.
    const context = { plugin: { id: materialization.pluginId, version: '0.0.0' },
        contribution: { id: 'health-observer', qualifiedId: `${materialization.pluginId}/backgroundServices/health-observer` },
        surface: 'background', invokedAtMs: now, materialization, signal: new AbortController().signal,
        services: { actions: { execute }, healthChecks: { read }, storage: { account: { kv: kv as AccountKvService } },
            events: { host: { subscribe: (target: { eventId: string }, listener: (event: { payload: JsonValue }) => void | Promise<void>) => {
                let listeners = hostListeners.get(target.eventId);
                if (!listeners) { listeners = new Set(); hostListeners.set(target.eventId, listeners); }
                listeners.add(listener);
                return { dispose() { listeners.delete(listener); } };
            } } } },
    } as unknown as BackgroundServiceContext;
    const adapter = createHealthCheckSourceAdapter(() => now, context.services.events.host);
    const errors: unknown[] = [];
    const cycle = (sourceAdapter = adapter, selectedContext = context) => runCheckpointedPluginEventObserverV1({
        context: selectedContext, source: { ...sourceAdapter, async observe(input) {
            try { return await sourceAdapter.observe(input); } catch (error) { errors.push(error); throw error; }
        } }, mode: 'once', now: () => now,
    });
    return { context, adapter, errors, read, writes, admissions, cycle, tick(value: HealthCheckResultV1['status']) { now += 1000; status = value; },
        clock(time: number) { now = time; },
        async heartbeat(payload: JsonValue) {
            for (const listener of hostListeners.get('@happier/health-check/heartbeat-received') ?? []) await listener({ payload });
        },
        async invalidate(payload: JsonValue) {
            for (const listener of hostListeners.get('@happier/automation/event-sources-invalidated') ?? []) await listener({ payload });
        },
        onSourceReport(listener: () => void) { sourceReports.add(listener); },
        configure(next: HealthCheckSourceConfigV1) { configuredSource = next; revision += 1; },
        safe(value: boolean) { safe = value; }, remove() { active = false; revision += 1; },
        assign(machineId: string) { watcher = { ...materialization, machineId }; revision += 1; },
        // A continuous runner retains its owner across adoption cycles. The
        // once-mode driver below deliberately supplies that retirement boundary.
        async retire() { await adapter.retire?.({ context, definitions: active ? [{ ...definition,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: watcher } }] : [],
            revision: String(revision), isCurrent: async () => true }); }, now: () => now };
}

describe('saved health source registration and finite cycles', () => {
    it('selects failed and recovered Events from one saved observer without evidence or duplicate failure runs', async () => {
        const f = fixture(source, ['health-check-failed', 'health-check-recovered']);
        await f.cycle(); f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0]).toMatchObject({ eventRef: { localId: 'health-check-failed' }, payload: {
            sourceInstanceId: definition.sourceInstanceId, subject: source.subject, checkId: 'http',
            transition: 'failed', observedAt: 2000,
        } });
        expect(f.admissions[0]?.payload).not.toHaveProperty('result');
        f.tick('degraded'); await f.cycle(); f.tick('degraded'); await f.cycle();
        expect(f.admissions).toHaveLength(1);
        f.tick('up'); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]).toMatchObject({ eventRef: { localId: 'health-check-recovered' }, payload: { transition: 'recovered' } });
        expect(f.read).toHaveBeenCalledTimes(5);
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.admissions).toHaveLength(2);
        expect(JSON.stringify(f.admissions)).not.toContain('http_status');
    });

    it.each(['http', 'certificate', 'tcp', 'dns', 'heartbeat'])('reaches the saved-selector %s producer through the registered manual Action', async (kind) => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
            services: { healthChecks: { read: async () => [{ checkId: kind, result: result('up', 1000) }] } } });
        try {
            const result = await kit.invokeAction(`health/${kind}`, {
                sourceInstanceId: 'health:service:machine-a:service-a', checkId: kind,
            });
            expect(HealthCheckResultV1Schema.parse(result).status).toBe('up');
        } finally {
            await kit.dispose();
        }
    });

    it('admits only threshold transitions and keeps equal ticks, unknown and absent assignment silent', async () => {
        const f = fixture();
        await f.cycle();
        await f.cycle();
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.admissions).toHaveLength(0);
        f.tick('unknown'); await f.cycle();
        f.tick('down'); await f.cycle();
        expect(f.admissions).toHaveLength(0);
        f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(1);
        const written = f.writes.length;
        for (let index = 0; index < 10; index++) { f.tick('down'); await f.cycle(); }
        expect(f.admissions).toHaveLength(1);
        expect(f.writes).toHaveLength(written);
        f.tick('up'); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]?.payload).toMatchObject({ transition: 'recovered' });
        expect(JSON.stringify(f.admissions)).not.toContain('private-path');
        const reads = f.read.mock.calls.length;
        await f.cycle(undefined, { ...f.context, materialization: { ...materialization, machineId: 'other' } });
        f.remove(); await f.cycle();
        expect(f.read).toHaveBeenCalledTimes(reads);
    });

    it('replays pending evidence and occurrence time after unsettled admission and reload without another probe', async () => {
        const f = fixture();
        await f.cycle(); f.tick('down'); f.safe(false); await f.cycle();
        const first = f.admissions[0];
        const reads = f.read.mock.calls.length;
        f.tick('up'); f.safe(true);
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.read).toHaveBeenCalledTimes(reads);
        expect(f.admissions[1]).toMatchObject({ occurrenceId: first?.occurrenceId,
            occurredAt: first?.occurredAt, payload: first?.payload });
        expect(f.writes.at(-1)).not.toHaveProperty('pending');
    });

    it('discards an incomplete live failure streak when its watcher assignment is withdrawn', async () => {
        const f = fixture();
        await f.cycle();
        f.assign('other'); f.tick('down'); await f.cycle(); await f.retire();
        expect(f.read).toHaveBeenCalledTimes(1);
        f.assign(materialization.machineId); f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(0);
        f.tick('down'); await f.cycle();
        expect(f.admissions).toHaveLength(1);
    });

    it.each([1, 3])('keeps first-ping and settled late checks quiet with threshold %i, using matching receipts and the exact age deadline', async (threshold) => {
        const f = fixture({ ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: threshold,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] });
        let nextEligibleAt: number | null = null;
        let state: HealthCheckResultV1['status'] = 'unknown';
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', result: result(state, f.now()), nextEligibleAt }]);
        await f.cycle();
        for (let index = 0; index < 10; index++) { f.tick('unknown'); await f.cycle(); }
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.admissions).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
        const wake = vi.fn(async () => {});
        const subscription = f.adapter.subscribeWake!(wake);
        try {
            const receipt = { sourceInstanceId: definition.sourceInstanceId, checkId: 'heartbeat',
                webhookEndpointId: 'endpoint', lastAcceptedAt: f.now() };
            await f.heartbeat({ ...receipt, checkId: 'another-check' });
            expect(wake).not.toHaveBeenCalled();
            state = 'up'; nextEligibleAt = f.now() + 1201;
            await f.heartbeat(receipt); await f.cycle();
            expect(wake).toHaveBeenCalledWith(definition.sourceInstanceId);
            expect(f.read).toHaveBeenCalledTimes(2);
            f.clock(nextEligibleAt - 1); await f.cycle();
            expect(f.read).toHaveBeenCalledTimes(2);
            f.clock(nextEligibleAt); state = 'down'; nextEligibleAt += 1000; await f.cycle();
            expect(f.read).toHaveBeenCalledTimes(3);
            for (let failure = 1; failure < threshold; failure++) {
                expect(f.admissions).toHaveLength(0);
                f.clock(nextEligibleAt); nextEligibleAt += 1000; await f.cycle();
            }
            expect(f.admissions).toHaveLength(1);
            for (let tick = 0; tick < 10; tick++) { f.clock(nextEligibleAt); nextEligibleAt += 1000; await f.cycle(); }
            expect(f.read).toHaveBeenCalledTimes(2 + threshold);
            expect(f.admissions).toHaveLength(1);
            expect(f.errors).toEqual([]);
        } finally { subscription.dispose(); }
    });

    it('re-reads a missed first receipt on reconnect while unrelated catalog invalidation stays quiet', async () => {
        const healthSource: HealthCheckSourceConfigV1 = { ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] };
        const f = fixture(healthSource);
        let acceptedAt: number | null = null;
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt: acceptedAt }, f.now()) }]);
        const completed = Array.from({ length: 3 }, () => {
            let resolve!: () => void;
            const promise = new Promise<void>(done => { resolve = done; });
            return { promise, resolve };
        });
        let observations = 0;
        // The SDK reports this public source status after committing its next
        // eligibility, so invalidation cannot race the initial cycle's write.
        f.onSourceReport(() => completed[observations++]?.resolve());
        const abort = new AbortController();
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal },
            source: f.adapter, now: f.now });
        try {
            await completed[0]!.promise;
            expect(f.read).toHaveBeenCalledTimes(1);
            await f.invalidate({}); await completed[1]!.promise;
            expect(f.read).toHaveBeenCalledTimes(1);
            // The first accepted ping arrived while this socket was disconnected;
            // reconnect carries the producer's reason, without replaying a ping.
            acceptedAt = f.now();
            await f.invalidate({ reason: 'reconnect' }); await completed[2]!.promise;
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
        } finally {
            abort.abort();
            await running;
        }
    });

    it('keeps a receipt wake that arrives while its previous finite read is still in flight', async () => {
        const f = fixture({ ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] });
        const observation = (lastAcceptedAt: number | null) => ({ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt }, f.now()) });
        let release!: (results: Awaited<ReturnType<typeof f.read>>) => void;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        f.read.mockImplementation(async () => [observation(f.now())]);
        f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
        const abort = new AbortController();
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal }, source: f.adapter, now: f.now });
        try {
            await reading;
            const delivered = f.heartbeat({ sourceInstanceId: definition.sourceInstanceId, checkId: 'heartbeat',
                webhookEndpointId: 'endpoint', lastAcceptedAt: f.now() });
            release([observation(null)]);
            await delivered;
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
        } finally { abort.abort(); await running; }
    });

    it('parks a producer-declared terminal endpoint refusal, then observes a changed saved endpoint', async () => {
        const healthSource: HealthCheckSourceConfigV1 = { ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] };
        const f = fixture(healthSource);
        f.read.mockRejectedValueOnce(new PluginError({ code: 'endpoint_unavailable', retryable: false }));
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt: f.now() }, f.now()) }]);
        let report!: () => void;
        let reported = new Promise<void>(resolve => { report = resolve; });
        f.onSourceReport(() => report());
        const abort = new AbortController();
        const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal }, source: f.adapter, now: f.now, sleep });
        try {
            await reported;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(sleep).not.toHaveBeenCalled();
            f.clock(f.now() + 10_000);
            expect(f.read).toHaveBeenCalledTimes(1);
            reported = new Promise<void>(resolve => { report = resolve; });
            f.configure({ ...healthSource, checks: [{ ...healthSource.checks[0]!, config: { webhookEndpointId: 'replacement', graceMs: 200 } }] });
            await f.invalidate({}); await reported;
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
            expect(f.adapter.retryAt({ error: new Error('native transport unavailable'), now: f.now(),
                definition: { ...definition, sourceConfig: healthSource } })).toBe(f.now() + 1000);
        } finally { abort.abort(); await running; }
    });
});
