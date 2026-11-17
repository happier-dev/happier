import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { PENDING_DELIVERY_BLOCKED_REASONS } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import { isPendingDeliveryProviderEffectPossibleV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { SessionTranscriptMessagePageResponseSchema } from './sessionMessagePageProjection';
import { createDbMaintenanceClient, type PrismaClientType } from '@/storage/prisma';
import { recordDriverStatements, type DriverStatementEvent } from '@/testkit/driverStatements';

interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    'Index Cond'?: string;
    'Recheck Cond'?: string;
    'Actual Rows': number;
    'Actual Loops': number;
    'Rows Removed by Filter'?: number;
    'Rows Removed by Index Recheck'?: number;
    Plans?: PlanNode[];
}

const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session activity pending idle proof (PostgreSQL)', () => {
    const statements: DriverStatementEvent[] = [];
    let client: PrismaClientType | undefined;
    let barrier: (() => void) | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { onDriverStatement: recordDriverStatements(event => {
            statements.push(event);
            if (event.query === 'SELECT 1 /* pending-idle-barrier */') barrier?.();
        }) });
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); vi.unstubAllEnvs(); });

    const drain = async () => {
        const observed = new Promise<void>(resolve => { barrier = resolve; });
        try {
            await client!.$queryRawUnsafe('SELECT 1 /* pending-idle-barrier */');
            await observed;
        } finally { barrier = undefined; }
    };

    const assertPendingPlan = async (statement: DriverStatementEvent, sessionId: string, maxRows: number) => {
        // Only fixture IDs, reasons and scalar flags may be replayed; never
        // replay lossy Date/binary query-event parameters.
        const values: unknown = JSON.parse(statement.params);
        if (!Array.isArray(values) || !values.every(value => value === null || typeof value === 'string'
            || typeof value === 'number' || typeof value === 'boolean')) {
            throw new Error('Pending scalar snapshot must have replayable scalar parameters');
        }
        expect(values).toContain(sessionId);
        const [explained] = await client!.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`, ...values);
        const nodes = planNodes(explained!['QUERY PLAN'][0]!.Plan);
        const scans = nodes.filter(node => node['Relation Name'] === 'SessionPendingMessage');
        expect(scans.length).toBeGreaterThan(0);
        const scanned = scans.reduce((total, node) => total + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
            + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'], 0);
        expect(scans.some(node => node['Node Type'].includes('Seq Scan'))).toBe(false);
        expect(nodes.some(node => node['Node Type'].includes('Index') && node['Index Cond']?.includes(sessionId))).toBe(true);
        expect(scanned).toBeGreaterThan(0);
        expect(scanned).toBeLessThanOrEqual(maxRows);
        return { scanned, scans: scans.map(node => ({ type: node['Node Type'], index: node['Index Name'],
            rows: node['Actual Rows'], loops: node['Actual Loops'], removed: node['Rows Removed by Filter'] ?? 0 })) };
    };

    it('captures activity counters and only page-local primary Pending twins in the message snapshot', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', pendingCount: 5, pendingBlockedCount: 4,
            pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 3 } });
        const unrelated = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const safeReason = PENDING_DELIVERY_BLOCKED_REASONS.find(reason => !isPendingDeliveryProviderEffectPossibleV1({ status: 'blocked', reason }))!;
        const [settledLocalId, oldLocalId, runLocalId, safeLocalId] = Array.from({ length: 4 }, () => randomUUID());
        const content = SessionStoredMessageContentSchema.parse({ t: 'plain', v: { role: 'user', content: { type: 'text', text: 'fixture input' } } });
        const pending = (sessionId: string, localId: string, position: number): Prisma.SessionPendingMessageCreateManyInput => ({ sessionId, localId, position,
            content, messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' },
            deliveryState: 'blocked', deliveryBlockedReason: safeReason });
        const originalTransaction = db.$transaction;
        try {
            await db.sessionMessage.createMany({ data: [settledLocalId!, oldLocalId!, runLocalId!, safeLocalId!]
                .map((localId, index) => ({ sessionId: session.id, localId, seq: index + 1, messageRole: 'user', content })) });
            // Reuse the existing Session-detail SQL contract's 201-row scale
            // for unrelated rows; this is an index-shape check, not a timing claim.
            await db.sessionPendingMessage.createMany({ data: [pending(session.id, oldLocalId!, 0), pending(session.id, safeLocalId!, 1),
                { ...pending(session.id, runLocalId!, 2), targetExecutionRunId: randomUUID() },
                { ...pending(session.id, randomUUID(), 3), deliveryBlockedReason: 'ambiguous_terminal_delivery' },
                { ...pending(session.id, randomUUID(), 4), deliveryBlockedReason: 'team_access_removed' },
                { ...pending(session.id, randomUUID(), 5), deliveryState: null, deliveryBlockedReason: null },
                { ...pending(session.id, randomUUID(), 6), status: 'discarded' },
                ...Array.from({ length: 201 }, (_, position) => pending(unrelated.id, randomUUID(), position)),
            ] });
            await db.$executeRawUnsafe('ANALYZE "SessionPendingMessage"');
            const traced = client!;
            db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
                return Reflect.apply(traced.$transaction, traced, args);
            } });
            await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
                const request = { method: 'GET' as const,
                    url: `/v1/sessions/${session.id}/messages?projection=activity&scope=main&limit=2`, headers: {
                        'x-test-user-id': owner.id,
                        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                    } };
                expect((await app.inject(request)).statusCode).toBe(200);
                await drain();
                statements.length = 0;
                const response = await app.inject(request);
                await drain();
                expect(response.statusCode, response.body).toBe(200);
                const body = SessionTranscriptMessagePageResponseSchema.parse(response.json());
                expect(body).toMatchObject({ activity: { pendingCount: 5, pendingBlockedCount: 4, pendingBlockedNoEffectCount: 2,
                    pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 3, latestTurnStatus: null } });
                expect(body.messages.map(row => row.localId).sort()).toEqual([runLocalId!, safeLocalId!].sort());
                expect(body.messages.find(row => row.localId === safeLocalId)).toMatchObject({ pendingOwnsTranscript: true });
                expect(body.messages.find(row => row.localId === runLocalId)).not.toHaveProperty('pendingOwnsTranscript');
                const captured = [...statements];
                const pendingReads = captured.filter(({ query }) => /^\s*(?:SELECT|WITH)\b/i.test(query)
                    && query.includes('"SessionPendingMessage"'));
                expect(pendingReads).toHaveLength(2);
                const counter = pendingReads.find(({ query }) => /count\s*\(/i.test(query))!;
                const twins = pendingReads.find(({ query }) => !/count\s*\(/i.test(query))!;
                expect(counter.query).toContain('"pendingCount"');
                expect(counter.query).toContain('"pendingBlockedCount"');
                expect(twins.query).toContain('"localId" IN');
                expect(twins.query).not.toContain('"content"');
                const twinParams: unknown = JSON.parse(twins.params);
                expect(twinParams).toEqual(expect.arrayContaining([session.id, runLocalId, safeLocalId]));
                expect(twinParams).not.toContain(oldLocalId);
                const pageRead = captured.find(({ query }) => /^SELECT\b/.test(query) && query.includes('FROM "public"."SessionMessage"'))!;
                const enclosingBegin = (statement: DriverStatementEvent) => {
                    for (let index = captured.indexOf(statement) - 1; index >= 0; index -= 1) {
                        if (/^BEGIN\b/.test(captured[index]!.query)) return index;
                    }
                    return -1;
                };
                const begin = enclosingBegin(pageRead);
                expect(begin).toBeGreaterThanOrEqual(0);
                expect(enclosingBegin(counter)).toBe(begin);
                expect(enclosingBegin(twins)).toBe(begin);
                const commit = captured.findIndex((event, index) => index > begin && /^COMMIT\b/.test(event.query));
                expect(commit).toBeGreaterThan(captured.indexOf(counter));
                expect(commit).toBeGreaterThan(captured.indexOf(twins));
                console.info('PENDING_ACTIVITY_POSTGRES_PLANS', JSON.stringify({ unrelatedCount: 201, pageRows: body.messages.length,
                    counter: await assertPendingPlan(counter, session.id, 7), twins: await assertPendingPlan(twins, session.id, 7) }));
                for (const cursor of ['afterSeq=0', 'beforeSeq=5']) {
                    statements.length = 0;
                    const cursorResponse = await app.inject({ ...request, url: `${request.url}&${cursor}` });
                    await drain();
                    expect(cursorResponse.statusCode, cursorResponse.body).toBe(200);
                    const cursorBody = SessionTranscriptMessagePageResponseSchema.parse(cursorResponse.json());
                    expect(cursorBody).not.toHaveProperty('activity');
                    const expectedPendingLocalId = cursor.startsWith('afterSeq') ? oldLocalId : safeLocalId;
                    expect(cursorBody.messages.find(row => row.localId === expectedPendingLocalId))
                        .toMatchObject({ pendingOwnsTranscript: true });
                    const cursorPendingReads = statements.filter(({ query }) => /^\s*(?:SELECT|WITH)\b/i.test(query)
                        && query.includes('"SessionPendingMessage"'));
                    expect(cursorPendingReads).toHaveLength(1);
                    expect(cursorPendingReads[0]!.query).not.toMatch(/count\s*\(/i);
                    expect(cursorPendingReads[0]!.query).not.toContain('"content"');
                    console.info('PENDING_ACTIVITY_CURSOR_POSTGRES_PLAN', JSON.stringify({ cursor,
                        ...await assertPendingPlan(cursorPendingReads[0]!, session.id, 7) }));
                }
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.sessionMessage.deleteMany({ where: { sessionId: session.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
