import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';

import { accessKeysRoutes } from '@/app/api/routes/accessKeys/accessKeysRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session Machine binding during sibling writes', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each([
        { method: 'POST', peerBinding: 'sibling' },
        { method: 'PUT', peerBinding: 'sibling' },
        { method: 'POST', peerBinding: 'same' },
    ] as const)('$method preserves an owned binding during a $peerBinding tuple write', async ({ method, peerBinding }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const sibling = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const binding = { accountId: account.id, machineId: machine.id, sessionId: session.id };
        const siblingKey = await db.accessKey.create({ data: { ...binding, sessionId: sibling.id, data: 'sibling', dataVersion: 1 } });
        if (method === 'PUT') await db.accessKey.create({ data: { ...binding, data: 'previous', dataVersion: 1 } });
        await db.$executeRaw`ANALYZE "AccessKey"`;
        const transaction = db.$transaction;
        let siblingCommits = 0;

        // Schedule only the real database boundary. Every attempt reaches the
        // production route, admission and binding writer with real PostgreSQL.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== 'accessKey') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.accessKey, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: unknown[]) => {
                            const row: unknown = await Reflect.apply(model.findUnique, model, queryArgs);
                            if (peerBinding === 'same' && siblingCommits > 0) return row;
                            await Reflect.apply(transaction, db, [async (peer: Tx) => {
                                await peer.accessKey.findUnique({ where: { accountId_machineId_sessionId: binding } });
                                if (peerBinding === 'same') await peer.accessKey.create({ data: { ...binding, data: 'peer-binding', dataVersion: 1 } });
                                else await peer.accessKey.update({ where: { id: siblingKey.id }, data: { dataVersion: { increment: 1 } } });
                            }, { isolationLevel: 'Serializable' }]);
                            siblingCommits += 1;
                            return row;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(accessKeysRoutes, async app => {
                const response = await app.inject({ method, url: `/v1/access-keys/${session.id}/${machine.id}`,
                    headers: { 'x-test-user-id': account.id }, payload: { data: 'owned-binding', ...(method === 'PUT' ? { expectedVersion: 1 } : {}) } });
                expect(response.statusCode, response.body).toBe(peerBinding === 'same' ? 409 : 200);
                if (peerBinding === 'sibling') expect(response.json()).toMatchObject(method === 'POST'
                    ? { success: true, accessKey: { data: 'owned-binding' } }
                    : { success: true, version: 2 });
                expect(siblingCommits).toBeGreaterThan(0);
            });
        } finally {
            db.$transaction = transaction;
        }
        await expect(db.accessKey.findUnique({ where: { accountId_machineId_sessionId: binding } }))
            .resolves.toMatchObject({ data: peerBinding === 'same' ? 'peer-binding' : 'owned-binding', dataVersion: method === 'POST' ? 1 : 2 });
    });
});
