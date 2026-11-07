import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { decodeBase64 } from 'privacy-kit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { clearAutomationRunHistory, deleteAutomation } from '@/app/automations/automationCrudService';
import { encodeAutomationRunCause } from '@/app/automations/automationRunCauseCodec';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { listWorkflowRuns } from './workflowRunService';

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
        await db.artifactTeamGrant.create({ data: { artifactId: sourceArtifactId, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const createRuns = async (count: number, automationId?: string) => {
            const ids = Array.from({ length: count }, () => randomUUID());
            await db.automationRun.createMany({ data: ids.map(id => ({ id, accountId: owner.id,
                automationId, originKind: automationId ? 'automation' : 'direct',
                ...(automationId ? encodeAutomationRunCause({ kind: 'manual', invokedAt: Date.now() }) : { causeKind: null }),
                sourceArtifactId, visibleTeamId: team.id,
                state: 'succeeded', workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: '{}',
                scheduledAt: new Date(), dueAt: new Date(), finishedAt: new Date() })) });
            if (!automationId) {
                const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
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
                        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: owner.id, runId: id }, acceptedSnapshot,
                    })), assignments: { create: { machineId: machine.id, priority: 0 } },
                } });
            }
            return ids;
        };
        return { owner, viewer, revoked, team, sourceArtifactId, artifactData, createRuns };
    }

    function sourceReads() {
        return queries.filter(query => /^SELECT\b/.test(query.query.trimStart()) && /FROM\s+"public"\."Artifact"(?:\s|$)/.test(query.query));
    }

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
        await db.artifactTeamGrant.createMany({ data: unrelatedIds.map((artifactId, index) => ({ artifactId, teamId: unrelatedTeams[index]!,
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
