import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionFilteredListingRoute } from '@/app/api/routes/session/registerSessionFilteredListingRoute';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { verifySessionQueryEquivalence, verifyBoundedSessionQueryContinuation } from './queryEquivalence.test-support';
import { SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE } from '@/app/session/personal/attentionQuery';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { resolveEffectiveSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionListScopeWhere, createSessionPersonalAttentionQueryInTx } from '@/app/session/personal/queries';
import { createSessionTranscriptPublicationActivityQueryBranches } from '@/app/session/sessionTranscriptPublicationPolicy';
import { createFilteredSessionListWhere, conjoinSessionListWhereInputs, createSessionListScopeQueryBranches } from './query';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { findV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from './page';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    'Actual Rows': number;
    'Actual Loops': number;
    'Rows Removed by Filter'?: number;
    Plans?: PlanNode[];
}

function summarize(plan: PlanNode): { scanned: number; nodes: string[] } {
    let scanned = 0;
    const nodes: string[] = [];
    const visit = (node: PlanNode) => {
        if (node['Relation Name'] === 'Session') {
            scanned += (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'];
            nodes.push(`${node['Node Type']}${node['Index Name'] ? `:${node['Index Name']}` : ''}`);
        }
        for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    return { scanned, nodes };
}

/** Prisma logs Date parameters as text; inline them with their SQL types for EXPLAIN. */
function inlineParams(sql: string, params: unknown[]): string {
    let result = sql;
    for (let index = params.length; index >= 1; index -= 1) {
        const value = params[index - 1];
        const literal = value === null ? 'NULL'
            : typeof value === 'number' || typeof value === 'boolean' ? String(value)
            : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)
                ? `'${value}'::timestamptz::timestamp`
                : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
        result = result.replaceAll(`$${index}`, literal);
    }
    return result;
}

/**
 * Measures the real `/v2/sessions/query` request on a heavy Account: how many
 * Session reads it issues and, for each, rows scanned against rows returned.
 * The captured Prisma arguments are replayed on a query-logging client so the
 * plans are the exact SQL the route sends.
 */
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session list query cost (PostgreSQL)', () => {
    const logged: Prisma.QueryEvent[] = [];
    let replay: PrismaClientType;
    beforeAll(async () => {
        replay = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        onDbClientQuery(replay, event => { logged.push(event); });
        initDbPostgres();
        await db.$connect();
        await replay.$connect();
    });
    afterAll(async () => { await replay.$disconnect(); await shutdownDbClient(); });

    it('preserves the monolithic membership, order and keysets over mixed publication and access', verifySessionQueryEquivalence);
    it('preserves exact rows beyond short candidate pages', verifyBoundedSessionQueryContinuation);

    it('bounds default hide-inactive page work at ten thousand Sessions', async () => {
        const prefix = `list-cost-${randomUUID()}`;
        const owner = await db.account.create({ data: { id: `${prefix}-owner`, publicKey: `${prefix}-key`, encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { id: `${prefix}-foreign`, publicKey: `${prefix}-foreign-key`, encryptionMode: 'plain' } });
        const sessionCount = Number(process.env.HAPPIER_TEST_LIST_COST_SESSIONS ?? 10_000);
        const ids = Array.from({ length: sessionCount }, (_, index) => `${prefix}-s-${String(index).padStart(6, '0')}`);
        const app = createAuthenticatedTestApp();
        registerSessionFilteredListingRoute(app);
        const headers = { 'x-test-user-id': owner.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        for (let offset = 0; offset < ids.length; offset += 2_000) {
            await db.session.createMany({ data: ids.slice(offset, offset + 2_000).map((id, slot) => {
                const index = offset + slot;
                return { id, accountId: owner.id, tag: id, encryptionMode: 'plain', metadataLayoutVersion: 1,
                    metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}', currentStorageState: 'hosted',
                    // ~3% live; one sparse Project with three old rows; the rest spread over 200 Projects.
                    active: index % 33 === 0,
                    projectKey: index < 3 ? 'sparse' : index % 50 === 7 ? null : `project-${index % 200}`,
                    meaningfulActivityAt: new Date(1_700_000_000_000 + index * 60_000) };
            }) });
        }
        const foreignCount = 2 * sessionCount;
        const foreignIds = Array.from({ length: foreignCount }, (_, index) => `${prefix}-f-${String(index).padStart(6, '0')}`);
        for (let offset = 0; offset < foreignIds.length; offset += 2_000) {
            await db.session.createMany({ data: foreignIds.slice(offset, offset + 2_000).map((id, slot) => ({
                id, accountId: foreign.id, tag: id, encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}', currentStorageState: 'hosted',
                active: true, projectKey: 'sparse', meaningfulActivityAt: new Date(1_800_000_000_000 + (offset + slot) * 60_000),
            })) });
        }
        const sharedIds = foreignIds.slice(-3);
        await db.sessionGrant.createMany({ data: (sharedIds.map(sessionId => ({ sessionId, createdByAccountId: foreign.id,
            accountId: owner.id, accessLevel: 'view' as const }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sessionId: foreignIds.at(-4)!,
            following: true, hasPersistentFollow: true } });
        await db.sessionMessage.createMany({ data: ids.slice(0, 2_000).map((sessionId, index) => ({ sessionId, seq: 1,
            localId: `${sessionId}-m`, authorAccountId: owner.id, createdAt: new Date(index),
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } } })) });
        await db.$executeRawUnsafe('ANALYZE "Session", "SessionMessage", "SessionShare", "AccountSessionFollow"');
        const measure = async (label: string, payload: Record<string, unknown>) => {
            const requests: Array<{ action: string; args: unknown }> = [];
            const stop = observePrismaRequests(db, { before(request) {
                if (request.model === 'Session') requests.push({ action: request.action, args: request.args });
            } });
            const started = performance.now();
            let body: { sessions: Array<{ id: string }>; nextCursor?: string | null; hasNext?: boolean;
                attentionNextCursor?: string | null; attentionHasNext?: boolean } = { sessions: [] };
            let status = 0;
            let serverTiming = '';
            try {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query',
                    headers: { ...headers, 'x-happier-session-list-timing': '1' }, payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', audiences: [], tagIds: [], limit: 50,
                    ...payload,
                } });
                status = response.statusCode;
                serverTiming = String(response.headers['server-timing'] ?? '');
                if (status === 200) body = response.json();
            } finally { stop(); }
            const elapsedMs = performance.now() - started;
            const plans = [];
            for (const request of requests) {
                if (request.action !== 'findMany') continue;
                const replayStarted = performance.now();
                logged.length = 0;
                await replay.session.findMany(request.args as Prisma.SessionFindManyArgs);
                const query = logged.find(event => event.query.startsWith('SELECT ') && event.query.includes('FROM "public"."Session"'));
                if (!query) continue;
                const [explained] = await replay.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inlineParams(query.query, JSON.parse(query.params))}`);
                const plan = explained['QUERY PLAN'][0];
                console.info('SESSION_QUERY_EXPLAIN', JSON.stringify({
                    label, branch: plans.length, query: query.query, params: JSON.parse(query.params), plan,
                }));
                plans.push({ executionMs: Math.round(plan['Execution Time']), replayMs: Math.round(performance.now() - replayStarted),
                    returned: plan.Plan['Actual Rows'], ...summarize(plan.Plan),
                    ...(process.env.HAPPIER_TEST_LIST_COST_SQL === '1' ? { sql: query.query.slice(0, 4000) } : {}) });
            }
            console.info('LIST_QUERY_COST', JSON.stringify({ label, status, sessionCount, foreignCount, elapsedMs: Math.round(elapsedMs),
                sessionReads: requests.length, returned: body.sessions.length, serverTiming, plans }));
            return { requests, plans, body, status, elapsedMs, serverTiming };
        };
        try {
            // Record the original first-page predicates without the new indexes.
            // PostgreSQL DDL is transactional: rollback restores the migration's
            // indexes before the real route runs. This is the guarded disposable DB.
            const rollbackBaseline = new Error('rollback disposable EXPLAIN baseline');
            try {
                await replay.$transaction(async tx => {
                    for (const name of ['hosted_activity', 'state_snapshot', 'hosted_created', 'incomplete_created']) {
                        await tx.$executeRawUnsafe(`DROP INDEX "Session_listing_${name}_idx"`);
                    }
                    const where = createFilteredSessionListWhere({ accountId: owner.id,
                        query: { v: 1, storage: 'active', scope: 'my_work', attention: 'any', includeInactive: false,
                            audiences: [], tagIds: [], limit: 50 },
                        accessWhere: (await resolveEffectiveSessionAccessWhere({ tx, mode: 'effective_access_v1',
                            accountId: owner.id, capability: 'readTranscript', authentication: createPresentUserSessionAccessAuthentication() })).where,
                        scopeWhere: await createSessionListScopeWhere({ tx, accountId: owner.id, scope: 'my_work' }),
                        audienceWhere: {}, attentionWhere: createSessionPersonalAttentionQueryInTx(tx, { accountId: owner.id }).candidateWhere,
                    });
                    let branch = 0;
                    for (const part of createSessionTranscriptPublicationActivityQueryBranches()) {
                        logged.length = 0;
                        await tx.session.findMany({ where: conjoinSessionListWhereInputs(where, part.where),
                            orderBy: [...part.orderBy], take: SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE + 1,
                            select: { id: true, createdAt: true, meaningfulActivityAt: true } });
                        const query = logged.find(event => event.query.startsWith('SELECT ') && event.query.includes('FROM "public"."Session"'));
                        if (!query) throw new Error('Missing baseline Session query');
                        const [explained] = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>>(
                            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inlineParams(query.query, JSON.parse(query.params))}`);
                        console.info('SESSION_QUERY_EXPLAIN', JSON.stringify({ label: 'before listing indexes', branch: branch++,
                            query: query.query, params: JSON.parse(query.params), plan: explained['QUERY PLAN'][0] }));
                    }
                    throw rollbackBaseline;
                }, { timeout: readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs });
            } catch (error) {
                if (error !== rollbackBaseline) throw error;
            }
            const ordinary = await measure('my_work hide-inactive', { includeInactive: false, includeAttention: true });
            expect.soft(ordinary.status).toBe(200);
            expect.soft(ordinary.plans.reduce((sum, plan) => sum + plan.scanned, 0)).toBeLessThan(sessionCount);
            expect.soft(ordinary.plans.flatMap(plan => plan.nodes).some(node => node.startsWith('Seq Scan'))).toBe(false);
            // One lookahead per candidate read and branch; the unique timestamps
            // allow at most one filtered cursor-boundary row, never a prior prefix.
            expect.soft(Math.max(...ordinary.plans.map(plan => plan.scanned)))
                .toBeLessThanOrEqual(SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE + 2);
            expect.soft((await measure("my_work all", { includeInactive: true, includeAttention: false })).status).toBe(200);
            const project = await measure('my_work all project=sparse', { includeInactive: true, includeAttention: false,
                projectKeys: { include: ['sparse'], exclude: [] } });
            expect(project.status).toBe(200);
            const selectable = new Set([...sharedIds, ...ids.slice(0, 3), ...ids.filter((_, index) => index % 50 === 7)]);
            expect(project.body.sessions.length).toBe(50);
            expect(project.body.sessions.every(row => selectable.has(row.id))).toBe(true);
            // Imports and creation batches can give many rows the same activity
            // timestamp. A cursor must seek by id within that tie, too.
            await db.session.updateMany({ where: { accountId: owner.id }, data: {
                meaningfulActivityAt: new Date(1_700_000_000_000),
            } });
            const tied = await measure('tied activity keysets', { includeInactive: false, includeAttention: true });
            expect.soft(tied.status).toBe(200);
            expect.soft(Math.max(...tied.plans.map(plan => plan.scanned)))
                .toBeLessThanOrEqual(SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE + 2);
            await db.session.updateMany({ where: { id: { in: ids.slice(0, 500) } }, data: { meaningfulActivityAt: null } });
            await db.session.updateMany({ where: { id: { in: ids.slice(500, 1000) } }, data: {
                currentStorageState: 'snapshot_complete', materializationPublicationId: 'fixture',
                materializedThroughSourceAt: BigInt(1_700_000_000_000), publishedThroughServerSeq: 0,
            } });
            await db.session.updateMany({ where: { id: { in: ids.slice(1000, 1500) } }, data: {
                currentStorageState: 'machine_only',
            } });
            await db.$executeRawUnsafe('ANALYZE "Session"');
            const mixed = await measure('mixed publication branches', { includeInactive: true, includeAttention: false });
            expect(mixed.status).toBe(200);
            // Both Account/activity indexes serve the same ordered, bounded
            // hosted keyset. PostgreSQL chooses between them from live stats.
            expect.soft(mixed.plans[0]?.nodes.some(node => node === 'Index Scan:Session_listing_hosted_activity_idx'
                || node === 'Index Scan:Session_accountId_meaningfulActivityAt_id_idx')).toBe(true);
            expect.soft(mixed.plans[0]?.scanned).toBe(mixed.plans[0]?.returned);
            expect.soft(mixed.plans.flatMap(plan => plan.nodes)).toEqual(expect.arrayContaining([
                'Index Scan:Session_listing_state_snapshot_idx',
                'Index Scan:Session_listing_hosted_created_idx', 'Index Scan:Session_listing_incomplete_created_idx',
            ]));
            await db.session.updateMany({ where: { accountId: owner.id }, data: { active: false } });
            await db.session.updateMany({ where: { accountId: foreign.id }, data: { active: false } });
            const quiet = await measure('all quiet (exact attention exhaustion)', { includeInactive: false, includeAttention: true });
            expect.soft(quiet.status).toBe(200);
            expect.soft(quiet.body.sessions).toHaveLength(0);
            expect.soft(quiet.body.hasNext).toBe(true);
            const candidateTiming = /happier_v2_sessions_candidates;desc="(\d+)\/(\d+)"/.exec(quiet.serverTiming);
            expect(candidateTiming).not.toBeNull();
            expect(Number(candidateTiming![1])).toBeLessThanOrEqual(Number(candidateTiming![2]));
            expect.soft(Math.max(...quiet.plans.map(plan => plan.scanned)))
                .toBeLessThanOrEqual(SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE + 2);
            expect.soft(quiet.requests.length).toBeLessThan(ordinary.requests.length + 10);
            const budgetMs = readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs;
            expect.soft(quiet.elapsedMs).toBeLessThan(budgetMs);
            const continued = await measure('quiet continuation budget', {
                includeInactive: false, includeAttention: false, cursor: quiet.body.nextCursor,
            });
            expect(continued.status).toBe(200);
            expect.soft(Math.max(...continued.plans.map(plan => plan.scanned)))
                .toBeLessThanOrEqual(2 * SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE + 2);
            const walkStarted = performance.now();
            let cursor = quiet.body.nextCursor;
            let pages = 1;
            const seenCursors = new Set<string>();
            while (cursor) {
                expect(seenCursors.has(cursor)).toBe(false);
                seenCursors.add(cursor);
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', audiences: [], tagIds: [], limit: 50,
                    includeInactive: false, includeAttention: false, cursor,
                } });
                expect(response.statusCode).toBe(200);
                const page = response.json();
                expect(page.sessions).toHaveLength(0);
                cursor = page.hasNext ? page.nextCursor : null;
                pages += 1;
            }
            let attentionCursor = quiet.body.attentionNextCursor;
            while (attentionCursor) {
                expect(seenCursors.has(`attention:${attentionCursor}`)).toBe(false);
                seenCursors.add(`attention:${attentionCursor}`);
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', audiences: [], tagIds: [], limit: 50,
                    includeInactive: false, includeAttention: false, attentionCursor,
                } });
                expect(response.statusCode).toBe(200);
                const page = response.json();
                expect(page.sessions).toHaveLength(0);
                attentionCursor = page.attentionHasNext ? page.attentionNextCursor : null;
                pages += 1;
            }
            const walkElapsedMs = quiet.elapsedMs + performance.now() - walkStarted;
            console.info('SESSION_QUERY_QUIET_WALK', JSON.stringify({ sessionCount, pages, elapsedMs: Math.round(walkElapsedMs), budgetMs }));
            expect(walkElapsedMs).toBeLessThan(budgetMs);
            // Re-baseline the retained unbounded exact reader against the same
            // current scope/access owners. Count actual admitted candidates,
            // rather than inferring its cost from the old query shape.
            let examined = 0;
            let timeout = false;
            const unboundedStarted = performance.now();
            try {
                await captureReadSnapshot(async tx => {
                    const access = await resolveEffectiveSessionAccessWhere({ tx, mode: 'effective_access_v1',
                        accountId: owner.id, capability: 'readTranscript', authentication: createPresentUserSessionAccessAuthentication() });
                    const attention = createSessionPersonalAttentionQueryInTx(tx, { accountId: owner.id });
                    const scopeWhere = await createSessionListScopeWhere({ tx, accountId: owner.id, scope: 'my_work' });
                    const filters = { accountId: owner.id,
                        query: { v: 1, storage: 'active', scope: 'my_work', attention: 'any', includeInactive: false,
                            audiences: [], tagIds: [], limit: 50 } satisfies SessionListQueryV1, accessWhere: access.where,
                        scopeWhere, audienceWhere: {}, attentionWhere: attention.candidateWhere };
                    const where = createFilteredSessionListWhere(filters);
                    const rows = await findV2SessionListRows({ userId: owner.id, orderBy: V2_SESSION_LIST_ORDER_BY,
                        take: 51, source: { kind: 'effective', reader: tx, baseWhere: where, accessMode: 'effective_access_v1',
                            baseWhereBranches: createSessionListScopeQueryBranches(scopeWhere).map(branch =>
                                createFilteredSessionListWhere({ ...filters, scopeWhere: branch })),
                            collectiveAccessSnapshot: access.collectiveAccessSnapshot },
                        rowAdmission: async candidates => { examined += candidates.length; return await attention.admitRows(candidates); } });
                    expect(rows).toHaveLength(0);
                    expect(examined).toBe(sessionCount);
                });
            } catch (error) {
                if (readDatabaseErrorCode(error) !== 'database_transaction_timeout') throw error;
                timeout = true;
            }
            console.info('SESSION_QUERY_UNBOUNDED_QUIET', JSON.stringify({ sessionCount, foreignCount, examined, timeout,
                elapsedMs: Math.round(performance.now() - unboundedStarted), budgetMs }));
        } finally {
            await app.close();
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: ids.slice(0, 2_000) } } });
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, foreign.id] } } });
            await db.account.delete({ where: { id: owner.id } });
            await db.account.delete({ where: { id: foreign.id } });
        }
    }, 600_000);
});
