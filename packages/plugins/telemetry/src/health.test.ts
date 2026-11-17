import { describe, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as database from '@happier-dev/database-protocol';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { localCaptureBackground } from './background.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import type { NormalizedMetricPoint } from './otlp/types.js';
import { readKeyFlowWindow } from './health.js';

function histogram(status: number, counts: string[]): NormalizedMetricPoint {
    return { metricType: 'histogram', name: 'http.server.request.duration', unit: 's', temporality: 'delta',
        serviceName: 'checkout', serviceVersion: 'v1', serviceInstanceId: 'one',
        startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', count: '1',
        bucketCounts: counts, explicitBounds: [0.01, 0.1],
        dimensions: { 'http.request.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': status } };
}

describe('published selected key-flow reads', () => {
    it('retains measured zero error intervals after cumulative failures stop', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
        try {
            // Counts remain measurable when all durations occupy the unbounded bucket.
            const point = (status: number, count: number, at: number): NormalizedMetricPoint => ({ ...histogram(status, ['0', '0', String(count)]),
                temporality: 'cumulative', count: String(count), timeUnixNano: String(at * 1_000_000) });
            const points = [point(200, 1, 2000), point(200, 2, 3000), point(500, 1, 2000), point(500, 1, 3000)];
            await lease.runtime.store.write(points.map((metric, index) => ({ id: `point-${index}`, worktree: 'environment:env',
                kind: 'metric' as const, source: 'otlp' as const, at: Number(metric.timeUnixNano) / 1_000_000, metric })));
            expect(await readKeyFlowWindow(lease.runtime, { environmentId: 'env', serviceName: 'checkout', since: 2000, until: 3000,
                measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'errorRate' } }))
                .toMatchObject({ measurements: { value: 0, errorRate: 0, requestCount: 1, completeness: 'complete' },
                    trend: [{ since: 2000, until: 3000, value: 0, errorRate: 0, count: 1, unit: '1' }] });
        } finally { await lease.release(); fixture.close(); }
    });
    it('orders sampled route trend by observation time at the retained read owner', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
        try {
            await lease.runtime.store.write([{ id: 'newer', worktree: 'environment:env', kind: 'span', source: 'otlp', at: 1500,
                serviceName: 'checkout', spanKind: 2, endpointMethod: 'POST', endpointRoute: '/returns', durationMs: 23 },
                { id: 'earlier', worktree: 'environment:env', kind: 'span', source: 'otlp', at: 1400,
                    serviceName: 'checkout', spanKind: 2, endpointMethod: 'POST', endpointRoute: '/returns', durationMs: 11 }]);
            expect(await readKeyFlowWindow(lease.runtime, { environmentId: 'env', serviceName: 'checkout', since: 1000, until: 2000,
                measure: { kind: 'route', routes: [{ method: 'POST', route: '/returns' }], statistic: 'p95' } }))
                .toMatchObject({ trend: [{ since: 1400, value: 11 }, { since: 1500, value: 23 }] });
        } finally { await lease.release(); fixture.close(); }
    });
    it('reads retained metric points through the real Action, scopes the source, and keeps error trends measured', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        // The daemon database and host admission are SDK process boundaries. The
        // real plugin, runtime, SQL store, metric arithmetic and DTOs run below them.
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        let admissions = 0;
        let metricsEnabled = true;
        let sourceEnvironmentId = 'env';
        const config = { environmentId: 'env', serviceName: 'checkout', serviceVersion: 'v1', windowMs: 1000,
            measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' },
            threshold: { operator: 'above', value: 50 } };
        const healthChecks = { readSource: async () => ({ v: 1,
            subject: { kind: 'environment', environmentId: sourceEnvironmentId }, checks: [{ checkId: 'flow',
                kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, binding: { kind: 'healthCheck' },
                config, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] }) } as unknown as PluginServices['healthChecks'];
        const capabilities = () => resolveDeploymentTelemetryCapabilitiesV1({ metrics: metricsEnabled });
        const deploymentTelemetry = { readAssignments: async () => [{ environmentId: 'env', tokenHash: null,
            capabilities: capabilities() }] } as unknown as PluginServices['deploymentTelemetry'];
        const deploymentDatabases = { admitTelemetryRead: async () => {
            admissions += 1;
            return { environment: { serverId: 'home', environmentId: 'env', revision: 1 }, collectorMachineId: 'collector',
                capabilities: capabilities() };
        } } as unknown as PluginServices['deploymentDatabases'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases, healthChecks, deploymentTelemetry } });
        try {
            const good = histogram(200, ['1', '0', '0']), error = histogram(500, ['0', '1', '0']);
            await lease.runtime.store.write([
                { id: 'ok', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 2000, metric: good },
                { id: 'error', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 2000, metric: error },
                { id: 'other', worktree: 'environment:other', kind: 'metric', source: 'otlp', at: 2000, metric: good },
            ]);
            fixture.statements.length = 0;
            const result = await host.invokeAction(database.databaseActionLocalIdV1(database.TELEMETRY_METRICS_READ_ACTION_ID_V1), {
                serverId: 'home', environmentId: 'env', serviceName: 'checkout', serviceVersion: 'v1', since: 1000, until: 2000,
                measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'errorRate' },
            });
            expect(result).toMatchObject({ result: { status: 'up', measurements: { value: 0.5, unit: '1',
                basis: 'metric_points', completeness: 'complete', requestCount: 2, p50Ms: 10, p95Ms: expect.closeTo(91) } },
                routes: [{ result: { measurements: { errorRate: 0.5 } } }], trend: [{ since: 1000, until: 2000, value: 0.5, unit: '1', count: 2 }] });
            expect(admissions).toBe(1);
            expect(fixture.statements.every(sql => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(true);
            await lease.runtime.store.write([
                { id: 'second-route', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 2000,
                    metric: { ...good, dimensions: { ...good.dimensions, 'http.route': '/status' } } },
                { id: 'another-service', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 2000,
                    metric: { ...good, serviceName: 'another-service' } },
                { id: 'outside-window', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 4000,
                    metric: { ...good, startTimeUnixNano: '3000000000', timeUnixNano: '4000000000' } },
            ]);
            const readHttp = (statistic: 'p95' | 'errorRate' | 'requests', serviceName = 'checkout') => host.invokeAction(
                database.databaseActionLocalIdV1(database.TELEMETRY_METRICS_READ_ACTION_ID_V1), {
                    serverId: 'home', environmentId: 'env', serviceName, serviceVersion: 'v1', since: 1000, until: 2000,
                    measure: { kind: 'http', statistic },
                });
            expect(await readHttp('p95')).toMatchObject({ result: { measurements: { requestCount: 3,
                p50Ms: expect.closeTo(7.5), p95Ms: expect.closeTo(86.5), errorRate: expect.closeTo(1 / 3),
                window: { since: 1000, until: 2000 } } }, routes: [], trend: [{ since: 1000, until: 2000,
                    unit: 'ms', value: expect.closeTo(86.5), count: 3, errorRate: expect.closeTo(1 / 3) }] });
            expect(await readHttp('errorRate')).toMatchObject({ result: { measurements: { value: expect.closeTo(1 / 3), unit: '1' } },
                trend: [{ value: expect.closeTo(1 / 3), unit: '1', count: 3 }] });
            expect(await readHttp('requests')).toMatchObject({ result: { measurements: { value: 3, unit: '{request}' } },
                trend: [{ value: 3, unit: '{request}', count: 3 }] });
            expect(await readHttp('p95', 'quiet-service')).toMatchObject({ result: { status: 'unknown',
                measurements: { completeness: 'unknown', reasons: ['no_traffic'] } }, trend: [] });
            const source = { kind: 'environment', serverId: 'home', environmentId: 'env' };
            expect(await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1), { source }))
                .toMatchObject({ ok: true, source, coverage: { lostObservations: 0 } });
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2000);
            const check = () => host.invokeAction(database.databaseActionLocalIdV1(database.TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1),
                { sourceInstanceId: 'health:environment:env', checkId: 'flow' }, { chosenMachine: { machineId: 'collector', installationId: 'installed' } });
            expect(await check()).toMatchObject({ status: 'degraded', latencyMs: expect.closeTo(91),
                measurements: { basis: 'metric_points', p95Ms: expect.closeTo(91), window: { since: 1000, until: 2000 } } });
            metricsEnabled = false;
            expect(await check()).toMatchObject({ status: 'unknown', cause: { reason: 'metrics_disabled' } });
            metricsEnabled = true; sourceEnvironmentId = 'other';
            expect(await check()).toMatchObject({ status: 'unknown', cause: { reason: 'health_check_subject_mismatch' } });
            const gauge: NormalizedMetricPoint = { metricType: 'gauge', name: 'process.cpu.time', unit: 's', temporality: 'unspecified',
                serviceName: 'checkout', serviceInstanceId: 'one', dimensions: {}, value: 2.5,
                startTimeUnixNano: '0', timeUnixNano: '1500250000' };
            await lease.runtime.store.write([{ id: 'runtime', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 1500, metric: gauge }]);
            expect(await host.invokeAction(database.databaseActionLocalIdV1(database.TELEMETRY_METRICS_READ_ACTION_ID_V1), {
                serverId: 'home', environmentId: 'env', serviceName: 'checkout', since: 1000, until: 2000,
                measure: { kind: 'runtime', metricName: gauge.name, statistic: 'latest' },
            })).toMatchObject({ result: { status: 'up', measurements: { value: 2.5 } }, trend: [{ since: 1500.25, until: 1500.25, value: 2.5 }] });
            await lease.runtime.store.write([{ id: 'returns', worktree: 'environment:env', kind: 'span', source: 'otlp', at: 1500,
                serviceName: 'checkout', spanKind: 2, endpointMethod: 'POST', endpointRoute: '/returns', durationMs: 23 },
                { id: 'returns-earlier', worktree: 'environment:env', kind: 'span', source: 'otlp', at: 1400,
                    serviceName: 'checkout', spanKind: 2, endpointMethod: 'POST', endpointRoute: '/returns', durationMs: 11 }]);
            const readSample = () => host.invokeAction(database.databaseActionLocalIdV1(database.TELEMETRY_METRICS_READ_ACTION_ID_V1), {
                serverId: 'home', environmentId: 'env', serviceName: 'checkout', since: 1000, until: 2000,
                measure: { kind: 'route', routes: [{ method: 'POST', route: '/returns' }], statistic: 'p95' },
            });
            expect(await readSample()).toMatchObject({ result: { measurements: { value: 23, completeness: 'partial', basis: 'sampled_spans' } },
                trend: [{ since: 1400, value: 11 }, { since: 1500, value: 23 }] });
            lease.runtime.recordCoverage('environment:env', 'store_busy');
            expect(await readSample()).toMatchObject({ result: { status: 'unknown', cause: { reason: 'capture_coverage_lost' } },
                routes: [{ result: { status: 'unknown', cause: { reason: 'capture_coverage_lost' } } }] });
        } finally { vi.useRealTimers(); await host.dispose(); await lease.release(); fixture.close(); }
    });
});
