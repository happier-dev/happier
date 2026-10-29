import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    SESSION_DRAFT_ROUTE_MUTATE, SESSION_DRAFT_ROUTE_READ,
    SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ,
    SessionDraftMutateResponseV1Schema, SessionDraftReadResponseV1Schema,
    SessionDraftMutateResponseV2Schema, SessionDraftReadResponseV2Schema,
} from '@happier-dev/protocol';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { readSessionDraft, tombstoneSessionDraftForLifecycleInTx } from './sessionDraftService';
import { sessionDraftPhysicalKey } from './sessionDraftPhysicalKey';
import { canonicalSessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { registerSessionDraftRoutes } from './registerSessionDraftRoutes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('draft mutation PostgreSQL contention', () => {
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

    it('set-rereads lifecycle tombstones while preserving every publication, timestamp and sibling draft', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const addresses = [
            { kind: 'session' as const, sessionId: session.id },
            ...Array.from({ length: 31 }, (_, index) => ({ kind: 'run' as const, sessionId: session.id, runId: `run-${index}` })),
        ];
        const sibling = { kind: 'run' as const, sessionId: `${session.id}-sibling`, runId: 'retained' };
        const before = new Date('2000-01-01T00:00:00Z');
        await db.userKVStore.createMany({ data: [...addresses, sibling].map(address => ({
            accountId: account.id, key: sessionDraftPhysicalKey(address)!, version: 3,
            value: Buffer.from(JSON.stringify({ t: 'encrypted', c: 'retained-before-delete' })),
            createdAt: before, updatedAt: before,
        })) });
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        const transaction = db.$transaction;
        // Observe real SQL; no internal admission, mutation or publication is replaced.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            expect(await inTx(tx => tombstoneSessionDraftForLifecycleInTx(tx, { accountId: account.id, sessionId: session.id }))).toBe(true);
            const reads = statements.filter(event => /^SELECT\b/.test(event.query.trimStart())
                && /FROM\s+"public"\."UserKVStore"(?:\s|$)/.test(event.query)).length;
            const publications = await db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: 'asc' } });
            expect(publications).toHaveLength(addresses.length);
            for (const address of addresses) {
                const stored = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: sessionDraftPhysicalKey(address)! } } });
                expect(await readSessionDraft({ accountId: account.id, address,
                    authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' }),
                })).toMatchObject({ status: 'deleted', record: {
                    address, revision: 4, content: null, createdAt: before.getTime(), updatedAt: stored.updatedAt.getTime(),
                } });
                expect(stored.updatedAt.getTime()).toBeGreaterThan(before.getTime());
            }
            expect(publications.map(row => row.entityId)).toEqual([...addresses].sort((a, b) => sessionDraftPhysicalKey(a)! < sessionDraftPhysicalKey(b)! ? -1 : 1)
                .map(address => `session-draft:${canonicalSessionDraftAddressV2(address)}`));
            expect(publications.every(row => {
                const hint = row.hint as { revision?: number; status?: string };
                return hint.revision === 4 && hint.status === 'deleted';
            })).toBe(true);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: sessionDraftPhysicalKey(sibling)! } } }))
                .toMatchObject({ version: 3, updatedAt: before });
            console.info('DRAFT_LIFECYCLE_SQL', JSON.stringify({ changed: addresses.length, reads, publications: publications.length }));
            // One census, one KV preflight, and at most one post-write set read.
            expect(reads).toBeLessThanOrEqual(3);
        } finally { db.$transaction = transaction; await client.$disconnect(); }
    });

    it.each([
        { mutateUrl: SESSION_DRAFT_ROUTE_MUTATE, readUrl: SESSION_DRAFT_ROUTE_READ,
            mutateSchema: SessionDraftMutateResponseV1Schema, readSchema: SessionDraftReadResponseV1Schema },
        { mutateUrl: SESSION_DRAFT_V2_ROUTE_MUTATE, readUrl: SESSION_DRAFT_V2_ROUTE_READ,
            mutateSchema: SessionDraftMutateResponseV2Schema, readSchema: SessionDraftReadResponseV2Schema },
    ])('commits $mutateUrl despite continuing Account cursor publication, preserving CAS and Account binding', async ({ mutateUrl, readUrl, mutateSchema, readSchema }) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const content = {
            t: 'plain' as const,
            v: { v: 1 as const, address, document: {
                v: 1 as const,
                composer: {
                    text: { mutationId: randomUUID(), value: 'retained under publication contention' },
                    mentions: { mutationId: randomUUID(), value: [] },
                    attachments: { mutationId: randomUUID(), value: [] },
                },
                target: { kind: 'newSession' as const, authoring: {} }, extensions: {},
            } },
        };
        const originalTransaction = db.$transaction;
        let peerPublications = 0;
        // Interleave a real independent Account publication after the draft's
        // existence read on every attempt. No internal decision is replaced.
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== 'account') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.account, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findUnique') return operation;
                        return async (...queryArgs: Parameters<typeof tx.account.findUnique>) => {
                            const row: unknown = await Reflect.apply(operation, delegate, queryArgs);
                            if (queryArgs[0]?.where.id === account.id && queryArgs[0]?.select?.id === true) {
                                await Reflect.apply(originalTransaction, db, [async (peer: Tx) => {
                                    await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                }]);
                                peerPublications++;
                            }
                            return row;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        try {
            await withAuthenticatedTestApp(registerSessionDraftRoutes, async app => {
                const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
                const response = await app.inject({ method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 'absent', content } });
                expect(response.statusCode, response.body).toBe(200);
                expect(mutateSchema.parse(response.json())).toMatchObject({ status: 'updated', record: { address, revision: 0, content } });
                expect(peerPublications).toBeGreaterThan(0);
                db.$transaction = originalTransaction;
                const read = await app.inject({ method: 'POST', url: readUrl, headers, payload: { address } });
                expect(read.statusCode, read.body).toBe(200);
                expect(readSchema.parse(read.json())).toMatchObject({ status: 'present', record: { revision: 0, content } });
                const stale = await app.inject({ method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 'absent', content: null } });
                expect(mutateSchema.parse(stale.json())).toMatchObject({ status: 'conflict', current: { revision: 0, content } });
                const contenders = await Promise.all([0, 1].map(() => app.inject({
                    method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 0, content: null },
                })));
                for (const contender of contenders) expect(contender.statusCode, contender.body).toBe(200);
                expect(contenders.map(contender => mutateSchema.parse(contender.json()).status).sort()).toEqual(['conflict', 'updated']);
                const deleted = await app.inject({ method: 'POST', url: readUrl, headers, payload: { address } });
                expect(readSchema.parse(deleted.json())).toMatchObject({ status: 'deleted', record: { revision: 1, content: null } });
                // A route bound to the wrong authenticated Account cannot read
                // the producer's persisted draft, even with its exact address.
                const misbound = await app.inject({ method: 'POST', url: readUrl,
                    headers: { ...headers, 'x-test-user-id': stranger.id }, payload: { address } });
                expect(readSchema.parse(misbound.json())).toEqual({ status: 'absent' });
            });
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.account.deleteMany({ where: { id: { in: [account.id, stranger.id] } } });
        }
    });
});
