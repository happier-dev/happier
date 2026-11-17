import { describe, expect, it, vi } from 'vitest';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { localCaptureBackground } from './background.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import type { NormalizedMetricPoint } from './otlp/types.js';

describe('retained regression Actions', () => {
    it('uses current paged deployment history and retained windows, without writing a baseline or scheduling from compare', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        // These are the daemon database and host Action transport boundaries;
        // the published plugin, SQL reads, analysis and P4 comparator are real.
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const calls: string[] = [];
        let liveFinish = 2000;
        let metricsEnabled = true;
        let windowMs = 1000;
        const actions = { execute: async (id: string, input: { cursor?: string }) => {
            calls.push(id);
            if (id !== 'deployments.receipts.list') throw new Error(`Unexpected effect: ${id}`);
            return input.cursor ? { ok: true, items: [{ id: 'old', state: 'succeeded', operation: 'deploy', settledAtMs: 500 }], nextCursor: null }
                : { ok: true, items: [{ id: 'live', state: 'succeeded', operation: 'deploy', settledAtMs: liveFinish }], nextCursor: 'older' };
        } } as unknown as PluginServices['actions'];
        const deploymentDatabases = { admitTelemetryRead: async () => ({
            environment: { serverId: 'home', environmentId: 'env', revision: 1 }, collectorMachineId: 'collector',
            capabilities: { queries: true, traces: true, metrics: metricsEnabled },
        }) } as unknown as PluginServices['deploymentDatabases'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, actions, deploymentDatabases } });
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(3000);
        try {
            const histogram = (start: number, finish: number, version: string, counts: string[]): NormalizedMetricPoint => ({
                metricType: 'histogram', name: 'http.server.request.duration', unit: 's', temporality: 'delta',
                serviceName: 'checkout', serviceVersion: version, serviceInstanceId: 'one',
                startTimeUnixNano: String(start * 1000000), timeUnixNano: String(finish * 1000000), count: '1',
                bucketCounts: counts, explicitBounds: [0.01, 0.1],
                dimensions: { 'http.request.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': 200 },
            });
            await lease.runtime.store.write([
                { id: 'before', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 2000, metric: histogram(1000, 2000, 'old', ['1', '0', '0']) },
                { id: 'after', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 3000, metric: histogram(2000, 3000, 'live', ['0', '1', '0']) },
                { id: 'late', worktree: 'environment:env', kind: 'metric', source: 'otlp', at: 4000, metric: histogram(3000, 4000, 'live', ['1', '0', '0']) },
            ]);
            fixture.statements.length = 0;
            const compare = () => host.invokeAction('capture/regressions/compare', { serverId: 'home', environmentId: 'env',
                serviceName: 'checkout', windowMs,
                measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' } });
            expect(await compare()).toMatchObject({ status: 'comparable', liveDeploymentId: 'live', previousDeploymentId: 'old',
                before: { measurements: { window: { since: 1000, until: 2000 }, value: expect.closeTo(9.5) } },
                after: { measurements: { window: { since: 2000, until: 3000 }, value: expect.closeTo(95.5) } },
                changePercent: expect.closeTo(905.2631579) });
            expect(calls).toEqual(['deployments.receipts.list', 'deployments.receipts.list']);
            expect(fixture.statements.every(sql => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(true);
            windowMs = 1200; vi.setSystemTime(3200);
            expect(await compare()).toMatchObject({ status: 'comparable', changePercent: expect.closeTo(905.2631579),
                before: { measurements: { completeness: 'partial', reasons: ['boundary_gap'], observedWindow: { since: 1000, until: 2000 } } },
                after: { measurements: { completeness: 'partial', reasons: ['boundary_gap'], observedWindow: { since: 2000, until: 3000 } } } });
            windowMs = 1000; vi.setSystemTime(4000);
            expect(await compare()).toMatchObject({ status: 'comparable', changePercent: 0,
                before: { measurements: { window: { since: 1000, until: 2000 } } },
                after: { measurements: { window: { since: 3000, until: 4000 }, value: expect.closeTo(9.5) } } });
            vi.setSystemTime(3000);
            // A deploy between arming and firing changes the windows at firing.
            liveFinish = 3000;
            expect(await compare()).toMatchObject({ status: 'inconclusive', reasons: ['observation_window_empty'] });
            metricsEnabled = false;
            calls.length = 0;
            expect(await compare()).toEqual({ status: 'inconclusive', reasons: ['metrics_disabled'] });
            expect(calls).toEqual([]);
        } finally { vi.useRealTimers(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it('computes one absolute instant from the successful receipt and delegates same-Workflow scheduling to the host', async () => {
        const seen: unknown[] = [];
        let receiptState = 'succeeded';
        let refuseSchedule = false;
        let includeTriggerId = true;
        const actions = { execute: async (id: string, input: unknown) => {
            seen.push({ id, input });
            if (id === 'deployments.receipts.get') return { ok: true, deployment: { id: 'deploy', environmentId: 'env', state: receiptState, settledAtMs: 2000 } };
            if (refuseSchedule) throw new PluginError({ code: 'workflow_definition_unavailable' });
            return { set: { automationId: 'same-set' }, ...(includeTriggerId ? { triggerId: 'once' } : {}) };
        } } as unknown as PluginServices['actions'];
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN, services: { actions } });
        try {
            expect(await host.invokeAction('capture/regressions/schedule', { serverId: 'home', environmentId: 'env', deploymentId: 'deploy',
                workflow: 'saved-workflow', project: { machineId: 'machine', directory: '/app' }, observationDelayMs: 1000 }))
                .toEqual({ scheduledAt: 3000, automationId: 'same-set', triggerId: 'once' });
            expect(seen).toEqual([
                { id: 'deployments.receipts.get', input: { serverId: 'home', deploymentId: 'deploy' } },
                { id: 'workflow.trigger.add', input: { workflow: 'saved-workflow', project: { machineId: 'machine', directory: '/app' },
                    trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt: 3000 } } } },
            ]);
            includeTriggerId = false;
            expect(await host.invokeAction('capture/regressions/schedule', { serverId: 'home', environmentId: 'env', deploymentId: 'deploy',
                workflow: 'saved-workflow', project: { machineId: 'machine', directory: '/app' }, observationDelayMs: 1000 }))
                .toEqual({ scheduledAt: 3000, automationId: 'same-set' });
            receiptState = 'failed'; seen.length = 0;
            await expect(host.invokeAction('capture/regressions/schedule', { serverId: 'home', environmentId: 'env', deploymentId: 'deploy',
                workflow: 'saved-workflow', project: { machineId: 'machine', directory: '/app' }, observationDelayMs: 1000 }))
                .rejects.toMatchObject({ code: 'deployment_unavailable' });
            expect(seen).toHaveLength(1);
            receiptState = 'succeeded'; refuseSchedule = true;
            await expect(host.invokeAction('capture/regressions/schedule', { serverId: 'home', environmentId: 'env', deploymentId: 'deploy',
                workflow: 'saved-workflow', project: { machineId: 'machine', directory: '/app' }, observationDelayMs: 1000 }))
                .rejects.toMatchObject({ code: 'workflow_definition_unavailable' });
        } finally { await host.dispose(); }
    });
});
