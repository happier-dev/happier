import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProviderConnectionsRoutes } from '@/app/account/providers/registerProviderConnectionsRoutes';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Gateway Account fence admission (PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect(); connected = true;
        process.env.HANDY_MASTER_SECRET ??= 'gateway-admission-disposable-test';
        await initEncrypt();
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it.each([1, 20])('commits Gateway slot/hub publication with %s overlapping Account publishers', async publisherCount => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceId = randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId,
            displayName: 'Disposable contract', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Disposable contract', kind: 'token', value: 'fixture' } },
        }))).toMatchObject({ ok: true });
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const connectionId = 'pc_gateway_admission';
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [{
            v: 1, id: connectionId, source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Gateway admission', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, purposeBindingDefaults: { 'openai-upstream': { kind: 'group', service, groupId: 'baseline' } },
            gatewayPlacement: { kind: 'sessionMachine' }, revision: 0, createdAt: 1, updatedAt: 1,
        }], secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: ref }, byMachineId: {} } } };
        const payload = ProviderConnectionsRowMutationV1Schema.parse({ expectedRevision: 'absent', sourceSettingsVersion: 0,
            content: { t: 'plain', v: catalog }, referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] });
        const app = createAuthenticatedTestApp(); registerProviderConnectionsRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const post = (body: unknown) => app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, headers, payload: body });
        const originalTransaction = db.$transaction;
        try {
            const created = await post(payload);
            expect(created.statusCode, created.body).toBe(200);
            expect(ProviderConnectionsRowMutationResponseV1Schema.parse(created.json())).toMatchObject({ status: 'updated', revision: 0 });
            const attempts: Array<{ elapsedMs: number; fenceMs?: number; sqlState?: string; blocked?: boolean }> = [];
            const publishers: Promise<unknown>[] = [];
            let committedPublications = 0;
            const peerScope = new AsyncLocalStorage<boolean>();
            db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function' || peerScope.getStore()) return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const start = performance.now();
                    const measurement: (typeof attempts)[number] = { elapsedMs: 0 };
                    attempts.push(measurement);
                    let interleaved = false;
                    const observed = new Proxy(tx, { get(inner, property, innerReceiver) {
                        const value = Reflect.get(inner, property, innerReceiver);
                        if (property !== '$queryRawUnsafe') return value;
                        return async (...queryArgs: unknown[]) => {
                            const sql = queryArgs[0];
                            if (interleaved || typeof sql !== 'string' || !sql.includes('"Account"') || !sql.includes('FOR UPDATE')) {
                                return Reflect.apply(value, inner, queryArgs);
                            }
                            interleaved = true;
                            const locked = deferred(), release = deferred();
                            let peerPid = 0;
                            const peer = peerScope.run(true, () => inTx(async other => {
                                const [backend] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                peerPid = backend.pid;
                                await acquireAccountSessionOwnerMetadataFenceInTx(other, account.id, 'serializing');
                                await markAccountChanged(other, { accountId: account.id, kind: 'account', entityId: 'gateway-admission-peer' });
                                locked.resolve(); await release.promise;
                            }, { isolationLevel: 'ReadCommitted' }));
                            await Promise.race([locked.promise, peer.then(() => { throw new Error('Peer exited before holding its Account fence'); })]);
                            const fenceStarted = performance.now();
                            const fence = Promise.resolve(Reflect.apply(value, inner, queryArgs));
                            // Attach immediately; the real fence may fail as soon as the peer commits.
                            let fenceSettled = false;
                            const settled = fence.then(result => ({ result }), error => ({ error }))
                                .finally(() => { fenceSettled = true; });
                            try {
                                while (!fenceSettled) {
                                    const [blocked] = await db.$queryRaw<Array<{ count: number }>>`
                                        SELECT count(*)::int AS count FROM pg_stat_activity
                                        WHERE ${peerPid} = ANY(pg_blocking_pids(pid))`;
                                    if (blocked.count > 0) {
                                        measurement.blocked = true;
                                        // Twenty independent publishers each loop three times.
                                        // Start while the real route is waiting; join after it commits.
                                        if (publisherCount > 1 && publishers.length === 0) {
                                            for (let publisher = 0; publisher < publisherCount; publisher++) {
                                                publishers.push((async () => {
                                                    for (let iteration = 0; iteration < 3; iteration++) {
                                                        await peerScope.run(true, () => inTx(other => markAccountChanged(other, {
                                                            accountId: account.id, kind: 'account', entityId: `publisher-${publisher}`,
                                                        }), { isolationLevel: 'ReadCommitted' }));
                                                        committedPublications++;
                                                    }
                                                })());
                                            }
                                        }
                                        break;
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 1));
                                }
                            } finally { release.resolve(); await peer; }
                            const outcome = await settled;
                            measurement.fenceMs = performance.now() - fenceStarted;
                            if ('error' in outcome) {
                                const error = outcome.error;
                                if (error && typeof error === 'object' && 'meta' in error
                                    && error.meta && typeof error.meta === 'object' && 'code' in error.meta
                                    && typeof error.meta.code === 'string') measurement.sqlState = error.meta.code;
                                throw error;
                            }
                            return outcome.result;
                        };
                    } });
                    try { return await callback(observed); }
                    finally { measurement.elapsedMs = performance.now() - start; }
                }, ...args.slice(1)]);
            } });
            const update = ProviderConnectionsRowMutationV1Schema.parse({ ...payload, expectedRevision: 0, sourceSettingsVersion: undefined,
                content: { t: 'plain', v: { ...catalog, connections: [{ ...catalog.connections[0], revision: 1, updatedAt: 2,
                    gatewayPlacement: { kind: 'machine', machineId: 'gateway-hub' },
                    purposeBindingDefaults: { 'openai-upstream': { kind: 'group', service, groupId: 'test-pool' } },
                }] } } });
            const response = await post(update);
            await Promise.all(publishers);
            console.info('C34_GATEWAY_ADMISSION', JSON.stringify({ publisherCount, committedPublications, status: response.statusCode, attempts }));
            expect(response.statusCode, response.body).toBe(200);
            expect(ProviderConnectionsRowMutationResponseV1Schema.parse(response.json())).toMatchObject({ status: 'updated', revision: 1 });
            expect(attempts).toHaveLength(1);
            expect(attempts[0]).toMatchObject({ blocked: true });
            expect(attempts[0].sqlState).toBeUndefined();
            expect(committedPublications).toBe(publisherCount > 1 ? publisherCount * 3 : 0);
            const read = await app.inject({ method: 'GET', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, headers });
            expect(read.json()).toMatchObject({ status: 'present', revision: 1, content: update.content });
        } finally { db.$transaction = originalTransaction; await app.close(); }
    });
});
