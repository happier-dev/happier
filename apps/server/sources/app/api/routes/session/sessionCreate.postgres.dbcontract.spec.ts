import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { registerSessionCreateOrLoadRoute } from './registerSessionCreateOrLoadRoute';
import { registerSessionLookupByTagsRoute } from './registerSessionLookupByTagsRoute';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session creation PostgreSQL contention', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('creates and restores the released Layout-0 tag while the Account cursor remains hot', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const body = { tag: randomUUID(), metadata: 'released-layout-zero-ciphertext', encryptionMode: 'e2ee' };
        const transaction = db.$transaction;
        let peer = false;
        let publications = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (peer || typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (!interleaved && query.includes('FROM "Account"') && query.includes('FOR ')) {
                            interleaved = true;
                            await inner.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                            peer = true;
                            try {
                                await inTx(peerTx => markAccountChanged(peerTx, { accountId: account.id, kind: 'account', entityId: 'legacy-peer' }));
                                publications++;
                            } finally { peer = false; }
                        }
                        return inner.$queryRawUnsafe(query, ...values);
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        try {
            await withAuthenticatedTestApp(registerSessionCreateOrLoadRoute, async app => {
                const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
                const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
                expect(created.statusCode, created.body).toBe(200);
                expect(created.json().created).toBe(true);
                const session = V2SessionByIdResponseSchema.parse(created.json()).session;
                await db.session.update({ where: { id: session.id }, data: { active: false, archivedAt: new Date(123) } });
                const restored = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                    payload: { ...body, metadata: 'losing-request-must-not-replace-stored-ciphertext' } });
                expect(restored.statusCode, restored.body).toBe(200);
                expect(restored.json()).toMatchObject({ created: false, session: { id: session.id, metadata: body.metadata } });
                expect(publications).toBeGreaterThanOrEqual(2);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ archivedAt: null });
                expect(await db.session.count({ where: { accountId: account.id, tag: body.tag } })).toBe(1);
            });
        } finally {
            console.info('SESSION_LEGACY_HOT_CURSOR', { publications });
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['none', 'run_step'] as const)('creates a private %s Session despite continuing peer cursor commits and keeps tag rejoin bound to the stored winner', async originKind => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const originRun = originKind === 'run_step' ? await db.automationRun.create({ data: {
            accountId: account.id, scheduledAt: new Date(), dueAt: new Date(), originKind: 'direct', causeKind: null,
            workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: '{}',
        } }) : null;
        const body = {
            tag: randomUUID(), metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
            ownerMetadata: { t: 'plain', v: { v: 1 } }, encryptionMode: 'plain',
            ...(originRun ? { originKind, originRunId: originRun.id, workDepth: 1 } : {}),
        };
        const originalTransaction = db.$transaction;
        let peerPublications = 0;
        let injectPeerWrites = true;
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (query.includes('FROM "Account"') && query.includes('FOR KEY SHARE') && values.includes(account.id)) {
                            // Start the owner's real PostgreSQL snapshot, then
                            // advance an independent cursor before its fence.
                            if (injectPeerWrites) {
                                await inner.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                                await Reflect.apply(originalTransaction, db, [async (peer: Tx) => {
                                    await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                }]);
                                peerPublications++;
                            }
                        }
                        return inner.$queryRawUnsafe(query, ...values);
                    };
                },
            })), ...args.slice(1)]);
        } });
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionCreateOrLoadRoute(app);
                registerSessionLookupByTagsRoute(app);
            }, async app => {
                const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
                const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
                expect(created.statusCode, created.body).toBe(200);
                const record = V2SessionByIdResponseSchema.parse(created.json()).session;
                expect(created.json().created).toBe(true);
                expect(peerPublications).toBeGreaterThan(0);
                injectPeerWrites = false;
                const rejoined = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
                expect(rejoined.statusCode, rejoined.body).toBe(200);
                expect(V2SessionByIdResponseSchema.parse(rejoined.json()).session.id).toBe(record.id);
                expect(rejoined.json().created).toBe(false);
                const concurrentBody = { ...body, tag: randomUUID() };
                const concurrent = await Promise.all([0, 1].map(() => app.inject({
                    method: 'POST', url: '/v1/sessions', headers, payload: concurrentBody,
                })));
                for (const response of concurrent) expect(response.statusCode, response.body).toBe(200);
                const concurrentRecords = concurrent.map(response => V2SessionByIdResponseSchema.parse(response.json()).session);
                expect(concurrentRecords[0].id).toBe(concurrentRecords[1].id);
                expect(concurrent.map(response => response.json().created).sort()).toEqual([false, true]);
                expect(await db.session.count({ where: { accountId: account.id, tag: concurrentBody.tag } })).toBe(1);
                const child = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                    payload: { ...body, tag: randomUUID(), originKind: 'session', originRunId: undefined, originSessionId: record.id, workDepth: 1 } });
                expect(child.statusCode, child.body).toBe(200);
                expect(V2SessionByIdResponseSchema.parse(child.json()).session.origin).toEqual({ kind: 'session' });
                expect(await db.session.count({ where: { accountId: account.id, tag: body.tag } })).toBe(1);
                expect(await db.session.findUniqueOrThrow({ where: { id: record.id }, select: { ownerMetadata: true } }))
                    .toEqual({ ownerMetadata: JSON.stringify(body.ownerMetadata) });
                if (originRun) {
                    const foreignRun = await db.automationRun.create({ data: {
                        accountId: stranger.id, scheduledAt: new Date(), dueAt: new Date(), originKind: 'direct', causeKind: null,
                        workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: '{}',
                    } });
                    for (const originRunId of [randomUUID(), foreignRun.id]) {
                        const forbiddenTag = randomUUID();
                        const refused = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                            payload: { ...body, tag: forbiddenTag, originRunId } });
                        expect(refused.statusCode, refused.body).toBe(403);
                        expect(await db.session.count({ where: { accountId: account.id, tag: forbiddenTag } })).toBe(0);
                    }
                }
                db.$transaction = originalTransaction;
                const lookup = await app.inject({ method: 'POST', url: '/v2/sessions/lookup-by-tags', headers,
                    payload: { tags: [body.tag] } });
                expect(lookup.statusCode, lookup.body).toBe(200);
                expect(lookup.json()).toMatchObject({ sessions: [{ id: record.id }] });
                const misbound = await app.inject({ method: 'POST', url: '/v2/sessions/lookup-by-tags',
                    headers: { ...headers, 'x-test-user-id': stranger.id }, payload: { tags: [body.tag] } });
                expect(misbound.statusCode, misbound.body).toBe(200);
                expect(misbound.json()).toMatchObject({ sessions: [] });
            });
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: { in: [account.id, stranger.id] } } });
            await db.account.deleteMany({ where: { id: { in: [account.id, stranger.id] } } });
        }
    });
});
