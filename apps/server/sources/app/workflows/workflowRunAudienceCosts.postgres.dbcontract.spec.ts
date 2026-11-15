import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { decodeBase64 } from 'privacy-kit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { clearAutomationRunHistory, deleteAutomation } from '@/app/automations/automationCrudService';
import { encodeAutomationRunCause } from '@/app/automations/automationRunCauseCodec';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { listWorkflowRuns } from './workflowRunService';
import { resolveWorkflowRunVisibilityScopesInTx } from './workflowRunAccess';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Workflow audience demand costs (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    let originalTransaction: typeof db.$transaction;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => queries.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        // Observe actual SQL; the transaction, authority owners and publication locks stay real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
    });

    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });

    async function fixture() {
        const [owner, viewer, revoked] = await Promise.all([0, 1, 2].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Workflow audience cost contract' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: viewer.id, role: 'member', status: 'active' },
            { teamId: team.id, accountId: revoked.id, role: 'member', status: 'suspended' },
        ] });
        const artifactData = (id: string) => ({ id, accountId: owner.id,
            header: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }))),
            body: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({}))),
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) });
        const sourceArtifactId = randomUUID();
        await db.artifact.create({ data: artifactData(sourceArtifactId) });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: sourceArtifactId, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const createRuns = async (count: number, automationId?: string, starterAccountId = owner.id) => {
            const ids = Array.from({ length: count }, () => randomUUID());
            await db.automationRun.createMany({ data: ids.map(id => ({ id, accountId: starterAccountId,
                automationId, originKind: automationId ? 'automation' : 'direct',
                ...(automationId ? encodeAutomationRunCause({ kind: 'manual', invokedAt: Date.now() }) : { causeKind: null }),
                sourceArtifactId, visibleTeamId: team.id,
                state: 'succeeded', workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: '{}',
                scheduledAt: new Date(), dueAt: new Date(), finishedAt: new Date() })) });
            if (!automationId) {
                const machine = await db.machine.create({ data: { id: randomUUID(), accountId: starterAccountId, metadata: '{}' } });
                const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
                    definition: { version: 1, blocks: [{ kind: 'wait', id: 'answer',
                        document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] },
                    context: { source: { kind: 'inline', sourceArtifactId }, inputs: {}, machineId: machine.id,
                        executionTarget: { kind: 'session' },
                        workspaceTarget: { project: { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' } },
                        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
                });
                for (const id of ids) await db.automationRun.update({ where: { id }, data: {
                    workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: starterAccountId, runId: id }, acceptedSnapshot,
                    })), assignments: { create: { machineId: machine.id, priority: 0 } },
                } });
            }
            return ids;
        };
        return { owner, viewer, revoked, team, sourceArtifactId, artifactData, createRuns };
    }

    function sourceReads() {
        return queries.filter(query => /^SELECT\b/.test(query.query.trimStart()) && /FROM\s+(?:"public"\.)?"Artifact"(?:\s|$)/.test(query.query));
    }

    it('selects the latest current-starter Run without paging newer Team history through the authenticated storage route', async () => {
        const f = await fixture();
        await db.teamMembership.create({ data: { teamId: f.team.id, accountId: f.owner.id, role: 'member', status: 'active' } });
        const [ownId] = await f.createRuns(1);
        await db.automationRun.update({ where: { id: ownId! }, data: { createdAt: new Date('2026-01-01') } });
        const teammateIds = await f.createRuns(3, undefined, f.viewer.id);
        await db.automationRun.updateMany({ where: { id: { in: teammateIds } }, data: { createdAt: new Date('2026-02-01') } });
        const input = { operation: 'list', request: { sourceArtifactId: f.sourceArtifactId, starter: 'current_account', limit: 1 },
            pageByteLimit: 1_000_000 };
        const app = createAuthenticatedTestApp();
        try {
            registerWorkflowRunStorageRoutes(app);
            await app.ready();
            queries.length = 0;
            const response = await app.inject({ method: 'POST', url: '/v3/automations/runs/workflow-storage',
                headers: { 'x-test-user-id': f.owner.id }, payload: input });
            expect(response.statusCode).toBe(200);
            const page = response.json();
            expect(page.runs.map((run: { id: string }) => run.id)).toEqual([ownId]);
            expect(page.nextCursor).toBeUndefined();
            const pageReads = queries.filter(query => /FROM\s+(?:"public"\.)?"AutomationRun"(?:\s|$)/.test(query.query)
                && /ORDER BY.*"createdAt"/s.test(query.query));
            expect(pageReads).toHaveLength(1);
        } finally { await app.close(); }
        expect((await listWorkflowRuns({ accountId: f.revoked.id, sourceArtifactId: f.sourceArtifactId,
            starter: 'current_account', limit: 1, pageByteLimit: 1_000_000 })).runs).toEqual([]);
        const shared = await listWorkflowRuns({ accountId: f.owner.id, sourceArtifactId: f.sourceArtifactId,
            limit: 1, pageByteLimit: 1_000_000 });
        expect(teammateIds).toContain(shared.runs[0]?.id);
        expect(shared.nextCursor).toEqual(expect.any(String));
        await expect(listWorkflowRuns({ accountId: f.owner.id, sourceArtifactId: f.sourceArtifactId,
            starter: 'current_account', cursor: shared.nextCursor, limit: 1, pageByteLimit: 1_000_000 }))
            .rejects.toMatchObject({ code: 'invalid_input' });
    });

    it.each([undefined, 'required'] as const)('admits default lists with attention=%s in set reads even without Runs', async attention => {
        const f = await fixture();
        const read = async (projection?: 'membership') => {
            queries.length = 0;
            const page = await listWorkflowRuns({ accountId: f.viewer.id, ...(attention ? { attention } : {}),
                ...(projection ? { projection } : {}), pageByteLimit: 1_000_000 });
            return { page, accessStatements: sourceReads().length,
                maxBindings: Math.max(0, ...sourceReads().map(query => (JSON.parse(query.params) as unknown[]).length)) };
        };
        const one = await read();
        const additionalIds = Array.from({ length: 100 }, () => randomUUID());
        await db.artifact.createMany({ data: additionalIds.map(f.artifactData) });
        await db.artifactGrant.createMany({ data: additionalIds.map(artifactId => ({ principalKind: 'team', artifactId, teamId: f.team.id,
            accessLevel: 'view', createdByAccountId: f.owner.id })) });
        const many = await read();
        console.info('WORKFLOW_DEFAULT_SOURCE_SQL', JSON.stringify({ attention, sources: 101,
            one: one.accessStatements, many: many.accessStatements, maxBindings: many.maxBindings }));
        expect(one.page.runs).toEqual([]);
        expect(many.page.runs).toEqual([]);
        expect(one.accessStatements).toBe(1);
        expect(many.accessStatements).toBe(one.accessStatements);

        const overflowIds = Array.from({ length: 900 }, () => randomUUID());
        await db.artifact.createMany({ data: overflowIds.map(f.artifactData) });
        await db.artifactGrant.createMany({ data: overflowIds.map(artifactId => ({ principalKind: 'team', artifactId, teamId: f.team.id,
            accessLevel: 'view', createdByAccountId: f.owner.id })) });
        const overflow = await read();
        console.info('WORKFLOW_DEFAULT_SOURCE_BIND_SQL', JSON.stringify({ attention, sources: 1001,
            statements: overflow.accessStatements, maxBindings: overflow.maxBindings }));
        expect(overflow.page.runs).toEqual([]);
        expect(overflow.accessStatements).toBe(2);
        expect(overflow.maxBindings).toBeLessThanOrEqual(999);
        const scopes = await inTx(tx => resolveWorkflowRunVisibilityScopesInTx(tx, { actorAccountId: f.viewer.id }));
        expect(new Set(scopes.map(scope => scope.sourceArtifactId)))
            .toEqual(new Set([f.sourceArtifactId, ...additionalIds, ...overflowIds]));

        const [runId] = await f.createRuns(1);
        if (attention) await db.workflowRunInvocation.create({ data: { id: randomUUID(), runId: runId!, sequence: 0n,
            memberOrdinal: 0n, attempt: 0n, lifecycle: 'waiting_for_review', contentEnvelope: '{}' } });
        const visibleProjection = attention ? 'membership' : undefined;
        expect((await read(visibleProjection)).page.runs.map(run => run.id)).toEqual([runId]);
        // Source lifecycle remains part of the same access owner, even though a live Team grant remains.
        await db.artifact.update({ where: { id: f.sourceArtifactId }, data: { deletedAt: new Date() } });
        expect((await read(visibleProjection)).page.runs).toEqual([]);
        await db.artifact.update({ where: { id: f.sourceArtifactId }, data: { deletedAt: null } });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.viewer.id } },
            data: { status: 'suspended' } });
        expect((await read(visibleProjection)).page.runs).toEqual([]);
    });

    it.each(['clear', 'delete'] as const)('keeps %s publication authority reads constant for 101 retained Runs sharing a source', async operation => {
        const f = await fixture();
        const runOperation = async (count: number) => {
            const automation = await db.automation.create({ data: { accountId: f.owner.id, name: 'Retained runs', enabled: true,
                templateCiphertext: '{}', templateVersion: 1 } });
            const runIds = await f.createRuns(count, automation.id);
            queries.length = 0;
            const result = operation === 'clear'
                ? await clearAutomationRunHistory({ accountId: f.owner.id, automationId: automation.id })
                : await deleteAutomation({ accountId: f.owner.id, automationId: automation.id });
            const sourceReadCount = sourceReads().length;
            const runFactReads = queries.filter(query => /^SELECT\b/.test(query.query.trimStart())
                && query.query.includes('"workflowAcceptedSnapshotEnvelope"') && query.query.includes('"AutomationRun"')).length;
            const accountLocks = queries.filter(query => /FROM "Account"/.test(query.query) && /FOR /.test(query.query));
            const lockParameters = JSON.stringify(accountLocks.map(query => JSON.parse(query.params)));
            expect(lockParameters).toContain(f.viewer.id);
            expect(lockParameters).not.toContain(f.revoked.id);
            const accountLockIndex = queries.findIndex(query => /FROM "Account"/.test(query.query) && /FOR /.test(query.query));
            const runLockIndex = queries.findIndex(query => /FROM "AutomationRun"/.test(query.query) && /FOR /.test(query.query));
            expect(accountLockIndex).toBeGreaterThanOrEqual(0);
            expect(runLockIndex).toBeGreaterThan(accountLockIndex);
            if (operation === 'clear') {
                expect(result).toEqual({ status: 'cleared', clearedRuns: count });
                expect(await db.automationRun.count({ where: { id: { in: runIds } } })).toBe(0);
            } else {
                expect(result).toEqual({ removedRevision: 1 });
                expect(await db.automationRun.count({ where: { id: { in: runIds } } })).toBe(count);
            }
            return { sourceReadCount, runFactReads };
        };
        const one = await runOperation(1);
        const many = await runOperation(101);
        console.info('WORKFLOW_BULK_AUDIENCE_SQL', JSON.stringify({ operation, one, many, retainedRuns: 101 }));
        expect(one.sourceReadCount).toBeGreaterThan(0);
        expect(many.sourceReadCount).toBe(one.sourceReadCount);
        expect(many.runFactReads).toBe(one.runFactReads);
    });

    it('selects Discussion Runs before pagination in one indexed PostgreSQL read', async () => {
        const f = await fixture();
        const [selectedId, unrelatedId] = await f.createRuns(2);
        const discussionId = randomUUID();
        await db.automationRun.update({ where: { id: selectedId }, data: { originDiscussionId: discussionId } });
        await db.automationRun.update({ where: { id: unrelatedId }, data: { createdAt: new Date(Date.now() + 1000) } });
        queries.length = 0;
        const page = await listWorkflowRuns({ accountId: f.viewer.id, originDiscussionId: discussionId,
            limit: 1, pageByteLimit: 1_000_000 });
        expect(page.runs.map(run => run.id)).toEqual([selectedId]);
        expect(page.nextCursor).toBeUndefined();
        const reads = queries.filter(query => /^SELECT\b/.test(query.query.trimStart())
            && /FROM\s+"public"\."AutomationRun"(?:\s|$)/.test(query.query)
            && /"originDiscussionId"\s*=/.test(query.query));
        expect(reads).toHaveLength(1);
        const plan = await db.$transaction(async tx => {
            await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
            return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
                'EXPLAIN SELECT "id" FROM "AutomationRun" WHERE "originDiscussionId" = $1 ORDER BY "createdAt" DESC, "id" DESC', discussionId);
        });
        expect(plan.some(row => row['QUERY PLAN'].includes('AutomationRun_originDiscussion_created_id_idx'))).toBe(true);
    });

    it('admits only the demanded source for exact Run selectors through the storage route, retaining live revocation', async () => {
        const f = await fixture();
        const [runId, otherRunId] = await f.createRuns(2);
        const exact = async (selector: { runId: string } | { runIds: string[] }) => {
            queries.length = 0;
            const page = await listWorkflowRuns({ accountId: f.viewer.id, ...selector, pageByteLimit: 1_000_000 });
            return { page, sourceReadCount: sourceReads().length,
                membershipReadCount: queries.filter(query => /^SELECT\b/.test(query.query.trimStart())
                    && /FROM\s+"public"\."TeamMembership"(?:\s|$)/.test(query.query)).length };
        };
        const baseline = await exact({ runId: runId! });
        const unrelatedIds = Array.from({ length: 1001 }, () => randomUUID());
        const unrelatedTeams = unrelatedIds.map(() => randomUUID());
        await db.artifact.createMany({ data: unrelatedIds.map(f.artifactData) });
        await db.team.createMany({ data: unrelatedTeams.map(id => ({ id, name: 'Unrelated workflow Team' })) });
        await db.teamMembership.createMany({ data: unrelatedTeams.map(teamId => ({ teamId, accountId: f.viewer.id, role: 'member' })) });
        await db.artifactGrant.createMany({ data: unrelatedIds.map((artifactId, index) => ({ principalKind: 'team', artifactId, teamId: unrelatedTeams[index]!,
            accessLevel: 'view', createdByAccountId: f.owner.id })) });
        for (const selector of [{ runId: runId! }, { runIds: [runId!] }]) {
            const selected = await exact(selector);
            console.info('WORKFLOW_EXACT_SOURCE_SQL', JSON.stringify({ selector: Object.keys(selector)[0],
                unrelatedSources: unrelatedIds.length, baseline: baseline.sourceReadCount, selected: selected.sourceReadCount,
                baselineMemberships: baseline.membershipReadCount, selectedMemberships: selected.membershipReadCount }));
            expect(selected.page.runs.map(row => row.id)).toEqual([runId]);
            expect(selected.sourceReadCount).toBe(baseline.sourceReadCount);
            expect(selected.membershipReadCount).toBe(baseline.membershipReadCount);
        }
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const read = (accountId: string, requestedRunId: string) => app.inject({ method: 'POST',
            url: '/v3/automations/runs/workflow-storage', headers: { 'x-test-user-id': accountId },
            payload: { operation: 'list', request: { runIds: [requestedRunId] }, pageByteLimit: 1_000_000 } });
        try {
            const response = await read(f.viewer.id, runId!);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().runs.map((row: { id: string }) => row.id)).toEqual([runId]);
            expect(WorkflowRunSummaryV1Schema.parse(response.json().runs[0]).id).toBe(runId);
            // The other selected id proves that route wiring does not silently discard the exact selector.
            expect((await read(f.viewer.id, otherRunId!)).json().runs.map((row: { id: string }) => row.id)).toEqual([otherRunId]);
            const misbound = await app.inject({ method: 'POST', url: '/v3/automations/runs/workflow-storage',
                headers: { 'x-test-user-id': f.viewer.id }, payload: { operation: 'list',
                    request: { runId, runIds: [otherRunId] }, pageByteLimit: 1_000_000 } });
            expect(misbound.statusCode, misbound.body).toBe(200);
            expect(misbound.json().runs).toEqual([]);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.viewer.id } }, data: { status: 'suspended' } });
            const revoked = await read(f.viewer.id, runId!);
            expect(revoked.statusCode, revoked.body).toBe(200);
            expect(revoked.json().runs).toEqual([]);
            expect((await exact({ runIds: [] })).page.runs).toEqual([]);
        } finally { await app.close(); }
    });
});
