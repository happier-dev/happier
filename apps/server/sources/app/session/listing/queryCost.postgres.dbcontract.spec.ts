import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionFilteredListingRoute } from '@/app/api/routes/session/registerSessionFilteredListingRoute';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
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

/** Rows each relation's scan nodes read (returned + filtered) across the plan, and the node types. */
function scannedByRelation(plan: PlanNode): { scanned: Record<string, number>; nodes: string[] } {
    const scanned: Record<string, number> = {};
    const nodes: string[] = [];
    const visit = (node: PlanNode) => {
        const relation = node['Relation Name'];
        if (relation) {
            scanned[relation] = (scanned[relation] ?? 0)
                + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'];
            nodes.push(`${relation}:${node['Node Type']}`);
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

    it('serves the default, all and Project-filtered My work pages from the viewer\'s index, never another Account\'s corpus', async () => {
        const prefix = `list-cost-${randomUUID()}`;
        const owner = await db.account.create({ data: { id: `${prefix}-owner`, publicKey: `${prefix}-key`, encryptionMode: 'plain' } });
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
        // Production tables hold every Account's Sessions: a listing must never
        // touch another Account's corpus to find the viewer's rows.
        const foreign = await db.account.create({ data: { id: `${prefix}-foreign`, publicKey: `${prefix}-fkey`, encryptionMode: 'plain' } });
        const foreignCount = 2 * sessionCount;
        const foreignIds = Array.from({ length: foreignCount }, (_, index) => `${prefix}-f-${String(index).padStart(6, '0')}`);
        for (let offset = 0; offset < foreignIds.length; offset += 2_000) {
            await db.session.createMany({ data: foreignIds.slice(offset, offset + 2_000).map((id, slot) => ({
                id, accountId: foreign.id, tag: id, encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}', currentStorageState: 'hosted',
                active: true, projectKey: 'sparse', meaningfulActivityAt: new Date(1_800_000_000_000 + (offset + slot) * 60_000),
            })) });
        }
        // Optional bystander corpus (HAPPIER_TEST_LIST_COST_BYSTANDER_SESSIONS):
        // a real Session table is dominated by other Accounts' rows, which the
        // authorship read's Session join reaches. Off by default to keep the run short.
        const bystander = await db.account.create({ data: { id: `${prefix}-bystander`, publicKey: `${prefix}-bkey`, encryptionMode: 'plain' } });
        const bystanderCount = Number(process.env.HAPPIER_TEST_LIST_COST_BYSTANDER_SESSIONS ?? 0);
        for (let offset = 0; offset < bystanderCount; offset += 5_000) {
            const slice = Array.from({ length: Math.min(5_000, bystanderCount - offset) }, (_, slot) => `${prefix}-b-${String(offset + slot).padStart(7, '0')}`);
            await db.session.createMany({ data: slice.map(id => ({ id, accountId: bystander.id, tag: id, encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}', currentStorageState: 'hosted',
                active: false, projectKey: null, meaningfulActivityAt: new Date(1_600_000_000_000 + offset) })) });
            await db.sessionMessage.createMany({ data: slice.map(sessionId => ({ sessionId, seq: 1, localId: `${sessionId}-m`,
                authorAccountId: bystander.id, createdAt: new Date(0),
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } } })) });
        }
        // Three newest foreign rows are shared with the viewer; one more is only
        // followed (no access) and must stay out.
        const sharedIds = foreignIds.slice(-3);
        await db.sessionGrant.createMany({ data: (sharedIds.map(sessionId => ({ sessionId, createdByAccountId: foreign.id,
            accountId: owner.id, accessLevel: 'view' as const }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sessionId: foreignIds.at(-4)!,
            following: true, hasPersistentFollow: true } });
        // A heavy author: the viewer wrote every prompt of its own Sessions
        // (authorship of those adds nothing to My work) and one message in a
        // shared foreign Session (the only authorship candidate).
        const messagesPerSession = Number(process.env.HAPPIER_TEST_LIST_COST_MESSAGES_PER_SESSION ?? 5);
        const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } } satisfies PrismaJson.SessionMessageContent;
        const authoredForeignId = sharedIds[0]!;
        const messages = [...ids.flatMap(sessionId => Array.from({ length: messagesPerSession }, (_, seq) => ({ sessionId, seq: seq + 1,
            localId: `${sessionId}-m${seq}`, authorAccountId: owner.id, createdAt: new Date(seq), content }))),
        { sessionId: authoredForeignId, seq: 1, localId: `${authoredForeignId}-m`, authorAccountId: owner.id, createdAt: new Date(0), content }];
        for (let offset = 0; offset < messages.length; offset += 5_000) {
            await db.sessionMessage.createMany({ data: messages.slice(offset, offset + 5_000) });
        }
        await db.$executeRawUnsafe('ANALYZE "Session", "SessionMessage", "SessionShare", "AccountSessionFollow"');
        const measure = async (label: string, payload: Record<string, unknown>) => {
            const requests: Array<{ action: string; args: unknown }> = [];
            const authorship: Array<{ args: unknown }> = [];
            let statements = 0;
            const stop = observePrismaRequests(db, { before(request) {
                statements += 1;
                if (request.model === 'Session') requests.push({ action: request.action, args: request.args });
                if (request.model === 'SessionMessage' && request.action === 'groupBy') authorship.push({ args: request.args });
            } });
            const started = performance.now();
            let body: { sessions: Array<{ id: string }> } = { sessions: [] };
            let status = 0;
            try {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', audiences: [], tagIds: [], limit: 50,
                    ...payload,
                } });
                status = response.statusCode;
                if (status === 200) body = response.json();
            } finally { stop(); }
            const elapsedMs = performance.now() - started;
            const plans = [];
            for (const request of requests) {
                if (request.action !== 'findMany') continue;
                const replayStarted = performance.now();
                logged.length = 0;
                await replay.session.findMany(request.args as Prisma.SessionFindManyArgs);
                const query = logged.find(event => event.query.startsWith('SELECT') && event.query.includes('FROM "public"."Session"'));
                if (!query) continue;
                const [explained] = await replay.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inlineParams(query.query, JSON.parse(query.params))}`);
                const plan = explained['QUERY PLAN'][0];
                plans.push({ executionMs: Math.round(plan['Execution Time']), replayMs: Math.round(performance.now() - replayStarted),
                    returned: plan.Plan['Actual Rows'], ...summarize(plan.Plan),
                    ...(process.env.HAPPIER_TEST_LIST_COST_SQL === '1' ? { sql: query.query.slice(0, 4000) } : {}) });
            }
            // Transcript authorship is read once per scope resolution; record its
            // plan so its growth with the viewer's message count stays visible.
            const authorshipPlans = [];
            for (const request of authorship) {
                logged.length = 0;
                await replay.sessionMessage.groupBy(request.args as Parameters<typeof replay.sessionMessage.groupBy>[0]);
                const query = logged.find(event => event.query.startsWith('SELECT') && event.query.includes('"SessionMessage"'));
                if (!query) continue;
                const [explained] = await replay.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inlineParams(query.query, JSON.parse(query.params))}`);
                const plan = explained['QUERY PLAN'][0];
                authorshipPlans.push({ executionMs: Math.round(plan['Execution Time']), returned: plan.Plan['Actual Rows'],
                    ...scannedByRelation(plan.Plan),
                    ...(process.env.HAPPIER_TEST_LIST_COST_SQL === '1' ? { sql: query.query.slice(0, 4000) } : {}) });
            }
            console.info('LIST_QUERY_COST', JSON.stringify({ label, status, sessionCount, elapsedMs: Math.round(elapsedMs),
                statements, sessionReads: requests.length, returned: body.sessions.length, plans, authorshipPlans }));
            return { requests, plans, authorshipPlans, body, status };
        };
        try {
            // The viewer's own rows plus the exact relation candidates (three
            // grants and one Follow); never the foreign corpus.
            const scannedBound = sessionCount + sharedIds.length + 1;
            const expectServed = (result: Awaited<ReturnType<typeof measure>>) => {
                expect(result.status).toBe(200);
                for (const plan of result.plans) {
                    expect(plan.nodes, JSON.stringify(plan.nodes)).not.toContain('Seq Scan');
                    expect(plan.scanned).toBeLessThanOrEqual(scannedBound);
                }
            };
            const ordinary = await measure('my_work hide-inactive', { includeInactive: false, includeAttention: true });
            expectServed(ordinary);
            const all = await measure('my_work all', { includeInactive: true, includeAttention: false });
            expectServed(all);
            // Shared foreign rows are newest; the followed-only foreign row has no access.
            expect(all.body.sessions.map(row => row.id)).toEqual([...[...sharedIds].reverse(), ...[...ids].reverse().slice(0, 47)]);
            const project = await measure('my_work all project=sparse', { includeInactive: true, includeAttention: false,
                projectKeys: { include: ['sparse'], exclude: [] } });
            expectServed(project);
            const selectable = new Set([...sharedIds, ...ids.slice(0, 3), ...ids.filter((_, index) => index % 50 === 7)]);
            expect(project.body.sessions.length).toBe(50);
            expect(project.body.sessions.every(row => selectable.has(row.id))).toBe(true);
        } finally {
            await app.close();
            await db.sessionMessage.deleteMany({ where: { authorAccountId: owner.id } });
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', accountId: owner.id } });
            await db.accountSessionFollow.deleteMany({ where: { accountId: owner.id } });
            await db.sessionMessage.deleteMany({ where: { authorAccountId: bystander.id } });
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, foreign.id, bystander.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, foreign.id, bystander.id] } } });
        }
    }, 600_000);
});
