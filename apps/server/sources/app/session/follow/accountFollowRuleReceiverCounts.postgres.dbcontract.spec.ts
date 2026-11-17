import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { buildSessionFollowRulePhysicalKeyV1, SessionFollowRuleStoredRowV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes, readSessionDetail } from '@/app/api/routes/session/registerSessionListingRoutes';
import { inReadSnapshot } from '@/storage/inTx';
import { listAccountFollowRuleRowsInTx, readAccountFollowRuleProjectionRowsInTx } from './accountFollowRuleService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { parseAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session receiver census physical SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); });

    it('measures private rule projection against the complete detail read on a thousand-Session Account', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessionIds = Array.from({ length: 1_000 }, () => randomUUID());
        await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId: owner.id, tag: id,
            metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', seq: 3 })) });
        const sessionId = sessionIds[0]!;
        await db.sessionMessage.createMany({ data: [1, 2, 3].map(seq => ({ sessionId, seq,
            createdAt: new Date(seq * 100), content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original' } } },
        })) });
        const authentication = createPresentUserSessionAccessAuthentication();
        const detailInput = { userId: owner.id, sessionId, authentication, accessProjectionVersion: 1,
            storedContentCompatibility: evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilityHttpHeadersV1({
                'x-happier-account-stored-content-protocol': '4',
            })) };
        const originalTransaction = db.$transaction;
        const traced = client!;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        try {
            for (const retained of [false, true]) for (const count of [0, 10, 100]) {
                await db.userKVStore.deleteMany({ where: { accountId: owner.id } });
                await db.userKVStore.createMany({ data: Array.from({ length: count }, (_, index) => ({
                    accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1(`measure-${index}`), version: 0,
                    createdAt: new Date(150 + index),
                    value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                        version: 0, receiver: index % 2 ? { kind: 'session', sessionId } : { kind: 'account' },
                        ...(!retained ? { inception: { createdAt: 150 + index, accountChangeCursor: 0 } } : {}),
                        content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
                    }))),
                })) });
                const measure = async (kind: 'detail' | 'without-rules' | 'projection') => {
                    statements.length = 0;
                    const started = performance.now();
                    if (kind === 'projection') {
                        const rows = await inReadSnapshot(tx => readAccountFollowRuleProjectionRowsInTx(tx, { accountId: owner.id, authentication }));
                        expect(rows?.status).toBe('listed');
                        if (rows?.status === 'listed') expect(rows.rows).toHaveLength(count);
                    } else {
                        const result = await readSessionDetail({ ...detailInput,
                            ...(kind === 'without-rules' ? { includePrivateRuleProjection: false } : {}) });
                        expect(result.status).toBe(200);
                        if (result.status === 200) {
                            expect(result.body.session.id).toBe(sessionId);
                            if (kind === 'detail') {
                                expect(result.body.session.receivedRuleCount).toBe(count / 2);
                                expect(result.body.session.viewer?.ruleReadStates ?? []).toHaveLength(count / 2);
                            }
                        }
                    }
                    const elapsedMs = performance.now() - started;
                    const selects = statements.filter(event => /^SELECT\b/.test(event.query));
                    return { elapsedMs, statements: statements.length, selects: selects.length,
                        sqlMs: selects.reduce((sum, event) => sum + event.duration, 0),
                        kvReads: selects.filter(event => event.query.includes('FROM "public"."UserKVStore"')).length,
                        originalReads: selects.filter(event => event.query.includes('FROM "public"."SessionMessage"')).length };
                };
                const results = [];
                for (const kind of ['detail', 'without-rules', 'projection'] as const) {
                    await measure(kind);
                    const samples = [];
                    for (let repeat = 0; repeat < 5; repeat++) samples.push(await measure(kind));
                    expect(new Set(samples.map(sample => sample.selects)).size).toBe(1);
                    results.push({ kind, ...samples[0], elapsedMs: median(samples.map(sample => sample.elapsedMs)),
                        sqlMs: median(samples.map(sample => sample.sqlMs)) });
                }
                console.info('FOLLOW_RULE_DETAIL_SHARE', JSON.stringify({ count, retained, sessions: sessionIds.length, samples: 5, results }));
            }
        } finally {
            db.$transaction = originalTransaction;
            await db.userKVStore.deleteMany({ where: { accountId: owner.id } });
            await db.sessionMessage.deleteMany({ where: { sessionId } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each([1, 4, 1100])('reads %i retained rules with their persisted creation facts in one KV read', async count => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createdAt = new Date(1234);
        await db.userKVStore.createMany({ data: Array.from({ length: count }, () => ({
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1(randomUUID()), version: 1, createdAt,
            value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                version: 1, receiver: { kind: 'account' },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            }))),
        })) });
        const originalTransaction = db.$transaction;
        const traced = client!;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            statements.length = 0;
            const listed = await inReadSnapshot(tx => listAccountFollowRuleRowsInTx(tx, { accountId: owner.id }));
            expect(listed.status).toBe('listed');
            if (listed.status !== 'listed') throw new Error('Expected retained rules');
            expect(listed.rows).toHaveLength(count);
            expect(listed.rows.every(row => row.envelope?.inception?.createdAt === createdAt.getTime())).toBe(true);
            const selects = statements.filter(event => /^SELECT\b/.test(event.query));
            console.info('RICH_RULE_INCEPTION_SQL', JSON.stringify({ rules: count, statements: statements.length, selects: selects.length }));
            expect(selects).toHaveLength(2);
        } finally { db.$transaction = originalTransaction; }
    });

    it('does not add SQL statements per retained rule to one Session detail request', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const addRule = () => db.userKVStore.create({ data: {
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1(randomUUID()), version: 1,
            value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                version: 1, receiver: { kind: 'session', sessionId: session.id },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            }))),
        } });
        const originalTransaction = db.$transaction;
        const traced = client!;
        // Observe engine-emitted SQL; only the persistent database transport changes.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
                const request = { method: 'GET' as const, url: `/v2/sessions/${session.id}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } };
                expect((await app.inject(request)).statusCode).toBe(200);
                const measure = async (rules: number) => {
                    statements.length = 0;
                    const response = await app.inject(request);
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json().session.id).toBe(session.id);
                    expect(response.json().session.receivedRuleCount).toBe(rules);
                    const selects = statements.filter(event => /^SELECT\b/.test(event.query));
                    return { rules, statements: statements.length, selects: selects.length,
                        inceptionReads: selects.filter(event => /FROM "public"\."UserKVStore"(?:\s|$)/.test(event.query)
                            && event.query.includes('"createdAt"') && !event.query.includes('"value"')).length };
                };
                await addRule();
                const one = await measure(1);
                await Promise.all(Array.from({ length: 3 }, addRule));
                const many = await measure(4);
                console.info('SESSION_RECEIVER_CENSUS_SQL', JSON.stringify({ one, many }));
                expect(many.selects).toBe(one.selects);
                expect(many.inceptionReads).toBe(0);
            });
        } finally { db.$transaction = originalTransaction; }
    });
});
