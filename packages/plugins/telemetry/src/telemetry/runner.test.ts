import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import type { DaemonDatabaseService } from '@happier-dev/plugin-sdk/storage';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createCaptureBackgroundOwner } from '../background.js';
import { createCaptureStore } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { runTelemetryCollector, telemetryCollectorRunner } from './runner.js';

describe('registered production collector runner', () => {
    it.each(['machine', 'deployed-app', 'machine-with-unavailable-findings'] as const)('publishes the %s collector, joins shutdown and resumes assigned telemetry after role restart', async placement => {
        let deployedAppPort: number | undefined;
        if (placement === 'deployed-app') {
            const reservation = createServer();
            await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
            const address = reservation.address();
            if (!address || typeof address === 'string') throw new Error('missing test port');
            deployedAppPort = address.port;
            await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
        }
        const fixture = createCaptureSqliteFixture();
        const owner = createCaptureBackgroundOwner();
        const lifetime = new AbortController();
        const restartedLifetime = new AbortController();
        let readEndpoint: (() => string | null) | null = null;
        const endpointNow = () => readEndpoint?.();
        let subscriptions = 0;
        let reads = 0;
        let assigned = true;
        let refresh: (() => Promise<void>) | undefined;
        let published = 0;
        const token = 'production-token';
        let initialized = false;
        const storage: DaemonDatabaseService = { async database(_name, options) {
            if (!initialized) {
                for (const migration of options.migrations ?? []) await migration.up(fixture.db);
                initialized = true;
            }
            return fixture.db;
        } };
        const subscribeToFindings = vi.fn(() => {
            throw new PluginError({ code: 'plugin_service_unavailable' });
        });
        const findingsContext = { services: { events: { host: { subscribe: subscribeToFindings } },
            logger: { warn: vi.fn() } } } as unknown as BackgroundServiceContext;
        const start = (signal: AbortSignal) => runTelemetryCollector({ signal,
            ...(placement === 'machine-with-unavailable-findings'
                ? { findings: { context: findingsContext, serverId: 'home', machineId: 'collector' } } : {}),
            services: { storage: { daemon: storage },
            deploymentTelemetry: {
                ...(deployedAppPort === undefined ? {} : { deployedAppPort }),
                async readAssignments() { reads++; return assigned ? [{ environmentId: 'A', tokenHash: createHash('sha256').update(token).digest('hex') }] : []; },
                subscribeAssignmentsChanged(notify) { refresh = notify; subscriptions++; return () => { subscriptions--; }; },
                exposeEndpoint(read) { published++; readEndpoint = read; return () => { published--; readEndpoint = null; }; },
            },
        } }, owner);
        const settled = start(lifetime.signal);
        void settled.catch(() => {});
        let restarted: Promise<void> | undefined;
        try {
            const endpointPattern = placement === 'deployed-app' ? /^http:\/\/0\.0\.0\.0:/ : /^http:\/\/127\.0\.0\.1:/;
            await vi.waitFor(() => expect(endpointNow()).toMatch(endpointPattern));
            if (deployedAppPort !== undefined) expect(new URL(endpointNow()!).port).toBe(String(deployedAppPort));
            if (placement === 'machine-with-unavailable-findings') {
                expect(subscribeToFindings).toHaveBeenCalledTimes(1);
                expect(findingsContext.services.logger.warn).toHaveBeenCalledWith(expect.any(String), { code: 'plugin_service_unavailable' });
            }
            const endpoint = endpointNow();
            const response = await fetch(`${endpoint}/v1/logs`, { method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000000000000000', body: { stringValue: 'observed' } }] }] }] }),
            });
            expect(response.status).toBe(200);
            await owner.readRuntime()?.ingest.settled();
            expect(await owner.readRuntime()?.store.listPartitions()).toEqual(['environment:A']);
            expect(reads).toBe(1);
            expect(subscriptions).toBe(1);
            assigned = false;
            await refresh?.();
            expect(published).toBe(0);
            expect(readEndpoint).toBeNull();
            await expect(fetch(`${endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
            assigned = true;
            await refresh?.();
            expect(published).toBe(1);
            expect(endpointNow()).toMatch(endpointPattern);
            expect(await owner.readRuntime()?.store.listPartitions()).toEqual([]);
            expect((await fetch(`${endpointNow()}/v1/logs`, { method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000001000000000', body: { stringValue: 'reassigned' } }] }] }] }),
            })).status).toBe(200);
            await owner.readRuntime()?.ingest.settled();
            lifetime.abort();
            await settled;
            expect(readEndpoint).toBeNull();
            expect(subscriptions).toBe(0);
            expect(owner.readRuntime()).toBeNull();
            await expect(fetch(`${endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();

            restarted = start(restartedLifetime.signal);
            void restarted.catch(() => {});
            await vi.waitFor(() => expect(endpointNow()).toMatch(endpointPattern));
            if (deployedAppPort !== undefined) expect(new URL(endpointNow()!).port).toBe(String(deployedAppPort));
            const restartedEndpoint = endpointNow();
            expect((await fetch(`${restartedEndpoint}/v1/logs`, { method: 'POST', headers: {
                Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            }, body: '{}' })).status).toBe(200);
            expect(await owner.readRuntime()?.store.listPartitions()).toContain('environment:A');
            expect(reads).toBe(4);
            expect(subscriptions).toBe(1);
        } finally {
            lifetime.abort(); restartedLifetime.abort();
            try { await Promise.all([settled, restarted]); }
            finally { fixture.close(); }
        }
    });
});

it('groups armed production findings and consumes a recurrence after Clear before admitting the next group', async () => {
    const fixture = createCaptureSqliteFixture();
    const lifetime = new AbortController();
    const materialization = { pluginId: 'happier.telemetry', machineId: 'collector', materializationId: 'installed' };
    const subject = { kind: 'environment' as const, serverId: 'home', environmentId: 'assigned' };
    const eventRef = { pluginId: materialization.pluginId, localId: 'production-finding-observed' };
    let endpoint: (() => string | null) | undefined;
    let invalidate: (() => void) | undefined;
    let definitions: readonly PluginCheckpointedEventSourceDefinitionV1[] = [];
    const admissions: Array<Readonly<{ occurrenceId: string; occurredAt: number; payload: unknown }>> = [];
    const databaseFindings: unknown[] = [];
    const databaseSubject = { kind: 'database', serverId: subject.serverId, target: {
        kind: 'managed_deployment', environmentId: subject.environmentId, targetLinkId: 'orders-link', databaseName: 'orders',
    } };
    const binding = { engine: 'postgresql', hostname: 'orders-db.test', port: 5432, database: 'orders', subject: databaseSubject };
    let selectedBindings = [binding];
    let notifyBindingsChanged: (() => void) | undefined;
    let selectedBindingReads = 0;
    const admitted = new Map<string, number>();
    const conflicts: string[] = [];
    const current = vi.fn();
    const token = 'fixture-exporter';
    const neighborToken = 'fixture-neighbor';
    const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
    // The Home Actions and signed invalidation are the boundary. HTTP ingest, capture SQLite and the SDK observer are real.
    const context = {
        plugin: { id: materialization.pluginId, version: '1.0.0' },
        contribution: { id: 'telemetry-collector', qualifiedId: 'happier.telemetry/backgroundServices/telemetry-collector' },
        materialization,
        surface: 'background',
        signal: lifetime.signal,
        invokedAtMs: Date.now(),
        services: {
            storage: { daemon: { async database(_name: string, options: Parameters<DaemonDatabaseService['database']>[1]) {
                for (const migration of options?.migrations ?? []) await migration.up(fixture.db);
                return fixture.db;
            } } },
            deploymentTelemetry: {
                serverId: subject.serverId,
                async readAssignments() { return [
                    { environmentId: subject.environmentId, tokenHash: hashToken(token) },
                    { environmentId: 'neighbor', tokenHash: hashToken(neighborToken) },
                ]; },
                subscribeAssignmentsChanged() { return () => {}; },
                databaseBindings: {
                    async read(environmentId: string) {
                        if (environmentId !== subject.environmentId) return [];
                        selectedBindingReads++;
                        return selectedBindings;
                    },
                    subscribeChanged(listener: (change: { kind: 'changes'; environmentIds: string[] }) => void) {
                        notifyBindingsChanged = () => listener({ kind: 'changes', environmentIds: [subject.environmentId] });
                        return () => { notifyBindingsChanged = undefined; };
                    },
                },
                exposeEndpoint(read: () => string | null) { endpoint = read; return () => { endpoint = undefined; }; },
            },
            events: { plugin: { async emit(_event: string, payload: unknown) { databaseFindings.push(payload); } },
                host: { subscribe(_target: unknown, receive: (change: unknown) => void) {
                invalidate = () => receive({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload: {} });
                return { dispose() { invalidate = undefined; } };
            } } },
            actions: { async execute(id: string, input: unknown) {
                if (id === 'automation.event.sources.list') return { kind: 'page', revision: String(definitions.length + 1), definitions, nextCursor: null };
                if (id === 'automation.event.source.status.report') { current(input); return { ok: true }; }
                if (id === 'automation.event.admit') {
                    const observation = input as (typeof admissions)[number];
                    admissions.push(observation);
                    const first = admitted.get(observation.occurrenceId);
                    if (first !== undefined && first !== observation.occurredAt) {
                        conflicts.push(observation.occurrenceId);
                        // Leave the Home round asynchronous so a runaway retry cannot starve the assertion.
                        await new Promise<void>(resolve => setImmediate(resolve));
                        return { results: [{ kind: 'blocked', checkpointSafe: false, reason: 'occurrenceConflict' }] };
                    }
                    admitted.set(observation.occurrenceId, observation.occurredAt);
                    return { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'workflow-run' }] };
                }
                throw new Error(`Unexpected fixture Action ${id}`);
            } },
        },
    } as unknown as BackgroundServiceContext;
    const running = telemetryCollectorRunner(context);
    let sequence = 0;
    async function sendTrace(exporter: string, serviceName = 'web', parameters?: readonly number[]) {
        const spanId = (++sequence).toString(16).padStart(16, '0');
        const traceId = spanId.padStart(32, '0');
        const startTimeUnixNano = BigInt(Date.now()) * 1_000_000n;
        const response = await fetch(`${endpoint?.()}/v1/traces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${exporter}` },
            body: JSON.stringify({ resourceSpans: [{
                resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
                scopeSpans: [{ spans: [{ traceId, spanId, name: 'GET /orders', kind: 2,
                    startTimeUnixNano: String(startTimeUnixNano), endTimeUnixNano: String(startTimeUnixNano + 1_000_000n),
                    status: { code: parameters ? 1 : 2 }, attributes: [
                        { key: 'http.request.method', value: { stringValue: 'GET' } },
                        { key: 'http.route', value: { stringValue: '/orders' } },
                        { key: 'http.response.status_code', value: { intValue: parameters ? '200' : '500' } },
                    ] }, ...(parameters ?? []).map(parameter => ({
                        traceId, spanId: (++sequence).toString(16).padStart(16, '0'), parentSpanId: spanId,
                        name: 'SELECT', kind: 3, startTimeUnixNano: String(startTimeUnixNano),
                        endTimeUnixNano: String(startTimeUnixNano + 500_000n), attributes: [
                            { key: 'db.system.name', value: { stringValue: 'postgresql' } },
                            { key: 'server.address', value: { stringValue: 'orders-db.test' } },
                            { key: 'server.port', value: { intValue: '5432' } },
                            { key: 'db.namespace', value: { stringValue: 'orders' } },
                            { key: 'db.query.text', value: { stringValue: 'SELECT $1::integer AS id' } },
                            { key: 'db.query.parameter.1', value: { intValue: String(parameter) } },
                        ],
                    }))] }],
            }] }),
        });
        expect(response.status).toBe(200);
        return traceId;
    }
    try {
        await vi.waitFor(() => expect(endpoint?.()).toMatch(/^http:\/\/127\.0\.0\.1:/));
        await sendTrace(token);
        expect(admissions).toEqual([]);
        const { PLUGIN_MANIFEST } = await import('../manifest.js');
        const event = PLUGIN_MANIFEST.contributes.events.find(candidate => candidate.id === eventRef.localId);
        expect(event?.automation?.subjectKinds).toEqual(['environment']);
        const setup = event?.automation?.source?.setupActionRef;
        expect(setup).toMatchObject({ pluginId: materialization.pluginId });
        // AE passes the stable installation and the Environment input returned by the setup Action.
        if (!setup) throw new Error('Production finding setup is unavailable');
        const { computeCanonicalDomainSeparatedDigest } = await import('@happier-dev/plugin-sdk');
        const sourceInstanceId = computeCanonicalDomainSeparatedDigest('happier.telemetry.production-finding-source.v1', [subject.serverId, subject.environmentId]);
        definitions = [{ automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'trigger',
            triggerRevision: 1, eventRef, sourceInstanceId, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
            sourceContractVersion: 1, sourceConfig: { v: 1, subject },
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
            filter: null, maximumObservationAgeMs: null }];
        invalidate?.();
        await vi.waitFor(() => expect(current.mock.calls).toContainEqual([expect.objectContaining({ kind: 'catalogReconciliation', adoptedRevision: '2' })]));
        await vi.waitFor(() => expect(current.mock.calls).toContainEqual([expect.objectContaining({ kind: 'source', state: 'observing' })]));
        await sendTrace(neighborToken);
        await sendTrace(token);
        await vi.waitFor(() => expect(admissions).toHaveLength(1));
        await sendTrace(token);
        await sendTrace(token, 'billing');
        await vi.waitFor(() => expect(admissions).toHaveLength(2));
        await sendTrace(token, 'web', [5, 5]);
        const traceId = await sendTrace(token, 'web', [5, 6, 7]);
        await sendTrace(neighborToken, 'web', [5, 6, 7]);
        await sendTrace(token, 'search');
        await vi.waitFor(() => expect(admissions).toHaveLength(3));
        expect(admissions).toEqual([['web', 'failing_endpoint'], ['billing', 'failing_endpoint'],
            ['search', 'failing_endpoint']].map(([name, kind]) => expect.objectContaining({
            eventRef, subjectContexts: [{ role: 'operand', subject }],
            payload: { subject, groupKey: expect.stringMatching(/^[a-zA-Z0-9_-]{43}$/), observation: expect.objectContaining({ kind,
                environmentObservation: { shapeKey: expect.any(String), reportedService: { kind: 'workload_reported', name } },
                verification: expect.objectContaining({ readBefore: expect.objectContaining({
                    input: expect.objectContaining({ source: subject }),
                }) }),
            }) },
        })));
        const groupKeys = admissions.map(({ payload }) => (payload as { groupKey: string }).groupKey);
        expect(new Set(groupKeys).size).toBe(3);
        const store = createCaptureStore(fixture.db, () => {});
        const partition = 'environment:assigned';
        const [query] = await store.list({ worktree: partition, traceId, kind: 'query', limit: 1 });
        expect((await store.traceDatabaseEndpointKeys(partition, traceId)).get(query.id)).toMatch(/^[a-zA-Z0-9_-]{43}$/);
        expect(JSON.stringify(await store.detail(partition, query.id))).not.toContain('orders-db.test');
        await vi.waitFor(() => expect(databaseFindings).toContainEqual(expect.objectContaining({ subject: databaseSubject,
            observation: expect.objectContaining({ kind: 'suspected_n_plus_one' }),
        })));
        expect(databaseFindings).toHaveLength(2);
        expect(JSON.stringify(databaseFindings)).not.toContain('orders-db.test');
        expect(selectedBindingReads).toBe(1);
        selectedBindings = [binding, { ...binding, subject: { ...databaseSubject,
            target: { ...databaseSubject.target, targetLinkId: 'other-orders-link' },
        } }];
        notifyBindingsChanged?.();
        await sendTrace(token, 'web', [5, 6, 7]);
        selectedBindings = [binding];
        notifyBindingsChanged?.();
        await sendTrace(token, 'web', [5, 6, 7]);
        await vi.waitFor(() => expect(databaseFindings).toHaveLength(3));
        expect(selectedBindingReads).toBe(3);
        await vi.waitFor(async () => expect(await store.pendingProductionFinding(partition)).toBeUndefined());
        await store.clear(partition);
        await sendTrace(token);
        await vi.waitFor(() => expect(conflicts).toContain(admissions[0].occurrenceId));
        await sendTrace(token, 'after-clear');
        await vi.waitFor(() => expect(admitted.size).toBe(4));
        expect(admissions.at(-1)?.payload).toMatchObject({ observation: {
            environmentObservation: { reportedService: { name: 'after-clear' } },
        } });
        expect(conflicts).toEqual([admissions[0].occurrenceId]);
    } finally {
        lifetime.abort();
        try { await running; }
        finally { fixture.close(); }
    }
});
