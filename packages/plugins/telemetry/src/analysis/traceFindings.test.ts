import { expect, it } from 'vitest';
import {
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DatabaseCaptureTraceGetResultV1Schema,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
    databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { localCaptureBackground } from '../background.js';
import { DATABASE_CAPTURE_PLUGIN } from '../manifest.js';
import { captureSourcePartition } from '../partition.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';

it('returns canonical committed evidence on the selected Environment trace through the collector read Action', async () => {
    const f = createCaptureSqliteFixture();
    const abort = new AbortController();
    for (const migration of captureMigrations) await migration.up(f.db);
    const storage = { daemon: { database: async () => f.db } } as PluginServices['storage'];
    const lease = await localCaptureBackground.acquireRuntime({ signal: abort.signal, services: { storage } });
    const environment = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
    const admissions: unknown[] = [];
    type DeploymentDatabases = NonNullable<PluginServices['deploymentDatabases']>;
    const deployments = {
        async admitTelemetryRead(input) {
            admissions.push(input);
            return {
                environment: { ...input, revision: 1 },
                collectorMachineId: 'collector',
                capabilities: { queries: true, traces: true, appLlmCost: false },
            };
        },
    } satisfies Pick<DeploymentDatabases, 'admitTelemetryRead'>;
    const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
        services: { storage, deploymentDatabases: deployments as DeploymentDatabases } });
    try {
        const partition = captureSourcePartition(environment, undefined);
        await lease.runtime.store.write([{ id: 'request', worktree: partition, kind: 'span', source: 'otlp', at: 100,
            traceId: 'trace', spanId: 'request', spanKind: 2, httpStatusCode: 503, durationMs: 40,
            endpointMethod: 'GET', endpointRoute: '/checkout', serviceName: 'checkout-api' }, {
            id: 'request2', worktree: partition, kind: 'span', source: 'otlp', at: 200,
            traceId: 'trace2', spanId: 'request2', spanKind: 2, httpStatusCode: 502, durationMs: 50,
            endpointMethod: 'GET', endpointRoute: '/checkout', serviceName: 'checkout-api' }]);
        const input = { source: environment, traceId: 'trace', page: { limit: 10 } };
        const traced = (traceId = input.traceId) => host.invokeAction(databaseActionLocalIdV1(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), { ...input, traceId },
            { chosenMachine: { machineId: 'collector', installationId: 'install' } });
        const result = await traced();
        expect(result).toMatchObject({ ok: true, findings: [{
            kind: 'failing_endpoint', environmentObservation: { shapeKey: expect.any(String),
                reportedService: { kind: 'workload_reported', name: 'checkout-api' } }, sourceScope: { serverId: 'home', machineId: 'collector' },
            observedWindow: { fromMs: 100, toMs: 140 }, summary: { records: 1, totalTimeMs: 40 },
            verification: {
                observationKey: 'request',
                httpStatusCode: 503,
                readBefore: { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input },
                findAfter: { action: DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
                    input: { source: environment, since: 140, page: { limit: 10 } } },
            },
        }] });
        const before = DatabaseCaptureTraceGetResultV1Schema.parse(result);
        const after = DatabaseCaptureTraceGetResultV1Schema.parse(await traced('trace2'));
        if (!before.ok || !after.ok) throw new Error('Expected two admitted traces');
        expect(after.findings?.[0]?.environmentObservation).toEqual(before.findings?.[0]?.environmentObservation);
        expect(after.findings?.[0]?.evidenceIdentity).not.toBe(before.findings?.[0]?.evidenceIdentity);
        expect(admissions).toEqual(Array.from({ length: 2 }, () => ({ serverId: 'home', environmentId: 'production' })));
    } finally {
        abort.abort();
        await host.dispose();
        await lease.release();
        f.close();
    }
});
