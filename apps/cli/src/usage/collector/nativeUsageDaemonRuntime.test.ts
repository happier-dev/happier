import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createNativeUsageDaemonRuntime } from './nativeUsageDaemonRuntime';
import { createNativeUsageCaptureStore } from './nativeUsageCaptureState';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';

describe('native usage daemon lifetime', () => {
    it('starts and reconnects an empty custody scope without discovering or opening native sources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-daemon-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            // OS observation boundary: empty, unrequested startup must never acquire a watch.
            watchFile: () => { throw new Error('No native watch may start without consent'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const runtime = createNativeUsageDaemonRuntime({
                authority: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' },
                installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token: 'token', storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                // Auth boundary: initial state loading is not an inventory/disclosure request.
                readCredentials: async () => { throw new Error('No source discovery may run unrequested'); },
            });
            try {
                expect(await runtime.owner.service.get()).toEqual([]);
                await runtime.flushPending();
                expect(await runtime.owner.service.get()).toEqual([]);
            } finally { await runtime.dispose(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('restores consented custody truthfully when its current plugin runtime is unavailable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-unavailable-'));
        const observation = createExternalSessionObservationDaemonProjection({
            publishField: async () => { throw new Error('No native Session may be fabricated'); },
            watchFile: () => { throw new Error('Unavailable sources cannot acquire a watch'); },
        });
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine' };
            const custodyKey = storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
                value: JSON.stringify(['capture', authority.serverId, authority.accountId, authority.machineId]) });
            const descriptor = { agent: { pluginId: 'fixture.unavailable', localId: 'agent' },
                source: { kind: 'fixture' }, sourceKey: 'fixture-root', root: directory, supported: true };
            const sourceId = deriveNativeUsageAccountingIdentity({ authority, storage, ...descriptor }).sourceRootKey;
            const store = createNativeUsageCaptureStore({ path: join(directory, 'usage', `${custodyKey}.sealed`), authority, storage });
            await store.save({ v: 1, authority, sources: [{ ...descriptor, sourceId, consented: true, pending: [] }] });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            const settledSources: Promise<unknown>[] = [];
            const runtime = createNativeUsageDaemonRuntime({
                authority, installationId: 'installation', activeServerDir: directory, serverHttpBaseUrl: 'https://server.test',
                token, storage, observation,
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                readCredentials: async () => ({ token, encryption: null }),
                invalidateSources: () => { settledSources.push(runtime.owner.service.get(sourceId)); },
            });
            try {
                await runtime.flushPending();
                expect(await runtime.owner.service.get(sourceId)).toEqual([expect.objectContaining({
                    consent: 'enabled', status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
                expect(await Promise.all(settledSources)).toContainEqual([expect.objectContaining({
                    status: 'unavailable', errorCode: 'source_unavailable', pendingCount: 0,
                })]);
            } finally { await runtime.dispose(); }
        } finally {
            await observation.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
