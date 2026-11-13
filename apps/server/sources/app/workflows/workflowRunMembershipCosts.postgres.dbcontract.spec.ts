import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { decodeBase64 } from 'privacy-kit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import {
    resolveWorkflowRunAccessInTx,
    resolveWorkflowRunAdmissionRecipientAccountIdsInTx,
    resolveWorkflowRunVisibilityScopesInTx,
} from './workflowRunAccess';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Workflow live membership set-read costs (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    let originalTransaction: typeof db.$transaction;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires an isolated Postgres contract database');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => queries.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        // Observe the real SQL boundary; membership, access and route logic remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });

    function costs() {
        const selects = queries.filter(event => /^SELECT\b/.test(event.query.trimStart()));
        return {
            membership: selects.filter(event => /FROM\s+"public"\."TeamMembership"(?:\s|$)/.test(event.query)).length,
            effectiveness: selects.filter(event => /FROM\s+"public"\."(?:TeamMembership|Team|Account)"(?:\s|$)/.test(event.query)).length,
        };
    }

    async function fixture(teamCount: number) {
        const [owner, actor, other] = await Promise.all([0, 1, 2].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const teamIds = Array.from({ length: teamCount }, () => randomUUID());
        const foreignTeamId = randomUUID();
        await db.team.createMany({ data: [...teamIds, foreignTeamId].map(id => ({ id, name: 'Membership costs' })) });
        await db.teamMembership.createMany({ data: [
            ...teamIds.map(teamId => ({ teamId, accountId: actor.id, role: 'member' as const })),
            { teamId: foreignTeamId, accountId: other.id, role: 'member' },
        ] });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            header: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow_definition.v1' }))),
            body: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({}))),
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
        await db.artifactGrant.createMany({ data: [...teamIds, foreignTeamId].map(teamId => ({ principalKind: 'team',
            teamId, artifactId: artifact.id, accessLevel: 'view' as const, createdByAccountId: owner.id,
        })) });
        const runIds = [randomUUID(), randomUUID()];
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, blocks: [{ kind: 'wait', id: 'answer',
                document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] },
            context: { source: { kind: 'inline', sourceArtifactId: artifact.id }, inputs: {}, machineId: machine.id,
                executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
        });
        await db.automationRun.createMany({ data: runIds.map((id, index) => ({ id, accountId: owner.id,
            originKind: 'direct' as const, causeKind: null, sourceArtifactId: artifact.id, visibleTeamId: teamIds[index]!,
            state: 'succeeded' as const, workflowCustodyState: 'settled' as const,
            workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: owner.id, runId: id }, acceptedSnapshot,
            })),
            scheduledAt: new Date(), dueAt: new Date(), finishedAt: new Date() })) });
        await db.automationRunAssignment.createMany({ data: runIds.map(runId => ({ runId, machineId: machine.id, priority: 0 })) });
        return { owner, actor, other, teamIds, foreignTeamId, artifact, runIds };
    }

    it('keeps route membership/effectiveness SQL constant at 5 and 25 Teams and withdraws revoked access on the next request', async () => {
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const measurements = [];
        try {
            for (const teamCount of [5, 25]) {
                const f = await fixture(teamCount);
                const read = async () => {
                    queries.length = 0;
                    const response = await app.inject({ method: 'POST', url: '/v3/automations/runs/workflow-storage',
                        headers: { 'x-test-user-id': f.actor.id }, payload: { operation: 'list',
                            request: { sourceArtifactId: f.artifact.id }, pageByteLimit: 1_000_000 } });
                    expect(response.statusCode, response.statusCode === 200 ? undefined : response.json().error).toBe(200);
                    const page: { runs: { id: string }[] } = response.json();
                    return { ids: page.runs.map(row => row.id).sort(), costs: costs() };
                };
                const initial = await read();
                expect(initial.ids).toEqual([...f.runIds].sort());
                measurements.push({ teamCount, ...initial.costs });
                const scopes = await inTx(tx => resolveWorkflowRunVisibilityScopesInTx(tx, {
                    actorAccountId: f.actor.id, sourceArtifactIds: [f.artifact.id],
                }));
                expect(scopes).toHaveLength(1);
                expect([...scopes[0]!.visibleTeamIds].sort()).toEqual([...f.teamIds].sort());
                expect(scopes[0]!.visibleTeamIds).not.toContain(f.foreignTeamId);

                await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.teamIds[1]!, accountId: f.actor.id } },
                    data: { status: 'suspended' } });
                expect((await read()).ids).toEqual([f.runIds[0]]);
                expect(await inTx(tx => resolveWorkflowRunAccessInTx(tx, { actorAccountId: f.actor.id, runId: f.runIds[1]! }))).toBeNull();
                const revoked = await inTx(tx => resolveWorkflowRunVisibilityScopesInTx(tx, {
                    actorAccountId: f.actor.id, sourceArtifactIds: [f.artifact.id],
                }));
                expect(revoked[0]!.visibleTeamIds).not.toContain(f.teamIds[1]);

                await db.team.update({ where: { id: f.teamIds[0]! }, data: { archivedAt: new Date() } });
                expect((await read()).ids).toEqual([]);
                await db.team.update({ where: { id: f.teamIds[0]! }, data: { archivedAt: null } });
                expect((await read()).ids).toEqual([f.runIds[0]]);
                await db.account.update({ where: { id: f.actor.id }, data: { status: 'suspended' } });
                expect((await read()).ids).toEqual([]);
            }
            console.info('PERF-WF2 visibility SQL counts', JSON.stringify(measurements));
            expect(measurements[0]!.membership).toBeGreaterThan(0);
            expect(measurements[1]!.membership).toBe(measurements[0]!.membership);
            expect(measurements[1]!.effectiveness).toBe(measurements[0]!.effectiveness);
        } finally { await app.close(); }
    });

    it('serves access-only membership without private columns and withdraws real Team access on the next request', async () => {
        const f = await fixture(5);
        await db.workflowRunInvocation.createMany({ data: f.runIds.map(runId => ({ id: randomUUID(), runId,
            sequence: 0n, memberOrdinal: 0n, attempt: 0n, lifecycle: 'waiting_for_review' as const,
            contentEnvelope: 'unopened retained hold' })) });
        const app = createAuthenticatedTestApp();
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const read = async (accountId = f.actor.id) => {
            queries.length = 0;
            const response = await app.inject({ method: 'POST', url: '/v3/automations/runs/workflow-storage',
                headers: { 'x-test-user-id': accountId }, payload: { operation: 'list',
                    request: { sourceArtifactId: f.artifact.id, projection: 'membership', attention: 'required' }, pageByteLimit: 1_000_000 } });
            expect(response.statusCode, response.body).toBe(200);
            const page: { runs: { id: string }[]; keyCensusByRunId: Record<string, unknown> } = response.json();
            expect(page.keyCensusByRunId).toEqual({});
            expect(queries.filter(event => /"(?:WorkflowRunDataKeyEnvelope|workflowAcceptedSnapshotEnvelope|contentEnvelope|contentPublicKey|contentPublicKeySig|publicKey)"/.test(event.query))).toEqual([]);
            return page.runs.map(run => run.id).sort();
        };
        try {
            expect(await read()).toEqual([...f.runIds].sort());
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.teamIds[0]!, accountId: f.actor.id } }, data: { status: 'suspended' } });
            expect(await read()).toEqual([f.runIds[1]]);
            await db.artifactGrant.deleteMany({ where: { principalKind: 'team', artifactId: f.artifact.id, teamId: f.teamIds[1]! } });
            expect(await read()).toEqual([]);
            expect(await read(f.owner.id)).toEqual([...f.runIds].sort());
        } finally { await app.close(); }
    });

    it('set-reads live key audiences at 5 and 25 recipients without admitting foreign, revoked or suspended Accounts', async () => {
        const measurements = [];
        for (const recipientCount of [5, 25]) {
            const f = await fixture(5);
            const accounts = await Promise.all(Array.from({ length: recipientCount }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
            await db.teamMembership.createMany({ data: accounts.map(account => ({
                teamId: f.teamIds[0]!, accountId: account.id, role: 'member' as const,
            })) });
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.teamIds[0]!, accountId: accounts[0]!.id } },
                data: { status: 'suspended' } });
            await db.account.update({ where: { id: accounts[1]!.id }, data: { status: 'suspended' } });
            queries.length = 0;
            const recipients = await inTx(tx => resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
                accountId: f.owner.id, sourceArtifactId: f.artifact.id, visibleTeamId: f.teamIds[0]!,
            }));
            measurements.push({ recipientCount, ...costs() });
            expect(recipients).toEqual([f.owner.id, f.actor.id, ...accounts.slice(2).map(account => account.id)].sort());
            expect(recipients).not.toContain(f.other.id);
        }
        console.info('PERF-WF2 audience SQL counts', JSON.stringify(measurements));
        expect(measurements[1]!.membership).toBe(measurements[0]!.membership);
        expect(measurements[1]!.effectiveness).toBe(measurements[0]!.effectiveness);
    });
});
