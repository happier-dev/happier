import { expect, it } from 'vitest';
import {
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
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
    const deployments = {
        admitTelemetryRead: async (input: unknown) => { admissions.push(input); },
    } as NonNullable<PluginServices['deploymentDatabases']>;
    const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
        services: { storage, deploymentDatabases: deployments } });
    try {
        const partition = captureSourcePartition(environment, undefined);
        await lease.runtime.store.write([{ id: 'request', worktree: partition, kind: 'span', source: 'otlp', at: 100,
            traceId: 'trace', spanId: 'request', spanKind: 2, httpStatusCode: 503, durationMs: 40,
            endpointMethod: 'GET', endpointRoute: '/checkout' }]);
        const input = { source: environment, traceId: 'trace', page: { limit: 10 } };
        const traced = () => host.invokeAction(databaseActionLocalIdV1(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), input,
            { chosenMachine: { machineId: 'collector', installationId: 'install' } });
        const result = await traced();
        expect(result).toMatchObject({ ok: true, findings: [{
            kind: 'failing_endpoint', sourceScope: { serverId: 'home', machineId: 'collector' },
            observedWindow: { fromMs: 100, toMs: 140 }, summary: { records: 1, totalTimeMs: 40 },
            verification: {
                observationKey: 'request',
                httpStatusCode: 503,
                readBefore: { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input },
                findAfter: { action: DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
                    input: { source: environment, since: 140, page: { limit: 10 } } },
            },
        }] });
        expect(admissions).toEqual([{ serverId: 'home', environmentId: 'production' }]);
        await lease.runtime.store.clear(partition);
        await expect(traced()).resolves.toMatchObject({ ok: true, findings: [] });
    } finally {
        abort.abort();
        await host.dispose();
        await lease.release();
        f.close();
    }
});
