import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { db, initDbPostgres } from '@/storage/db';
import { commitWorkflowInvocationFact } from './workflowRunService';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('lost Workflow operation observation (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['needs_attention', 'outcome_uncertain'] as const)('records loss from %s through the assigned interrupted observation CAS without claiming or changing the parent', async initialLifecycle => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const run = await db.automationRun.create({ data: {
            accountId: account.id, originKind: 'direct', causeKind: null, state: 'interrupted',
            scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
            workflowAcceptedSnapshotEnvelope: '{}', attempt: 1, claimedByMachineId: null,
            assignments: { create: { machineId: machine.id, priority: 0 } },
        } });
        const rootId = randomUUID(), childId = randomUUID();
        const seal = (root: boolean, lost = false) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: account.id, runId: run.id,
                recordId: root ? rootId : childId, sequence: root ? '0' : '1', parentRecordId: root ? null : rootId,
                memberOrdinal: '0', attempt: '0' },
            progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
                invocationPath: { blockId: root ? '$root' : 'setup', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
                ...(!root ? { reason: { code: lost ? 'action_operation_not_found' : initialLifecycle === 'needs_attention' ? 'project_setup_consent_required' : 'outcome_uncertain' },
                    execution: { kind: 'action' as const, actionId: 'projects.script.run', actionRequestId: 'request', localInputId: 'request',
                        input: {}, output: {}, awaitedOperations: [{ key: 'command', serverId: 'home', machineId: machine.id, operationId: 'lost' }] } } : {}),
            },
        }));
        await db.workflowRunInvocation.create({ data: { id: rootId, runId: run.id, sequence: 0n, memberOrdinal: 0n,
            attempt: 0n, lifecycle: 'running', contentEnvelope: seal(true) } });
        await db.workflowRunInvocation.create({ data: { id: childId, runId: run.id, sequence: 1n, parentRecordId: rootId,
            memberOrdinal: 0n, attempt: 0n, lifecycle: initialLifecycle, contentEnvelope: seal(false) } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error('Missing fixture currentness');
        const fact = { accountId: account.id, runId: run.id, machineId: machine.id, accountCurrentness,
            expectedRevision: run.revision, invocationId: childId, invocationAttempt: 0n, expectedContentRevision: 0n,
            expectedLifecycle: initialLifecycle, lifecycle: 'outcome_uncertain' as const,
            resolution: 'observed_terminal_execution' as const, contentEnvelope: seal(false, true) };
        await expect(commitWorkflowInvocationFact({ ...fact, machineId: randomUUID() })).rejects.toMatchObject({ code: 'currentness_conflict' });
        await expect(commitWorkflowInvocationFact({ ...fact, expectedRevision: run.revision + 1 })).rejects.toMatchObject({ code: 'currentness_conflict' });
        const parentBefore = await db.automationRun.findUniqueOrThrow({ where: { id: run.id } });
        await expect(commitWorkflowInvocationFact(fact)).resolves.toMatchObject({ lifecycle: 'outcome_uncertain', contentRevision: '1' });
        await expect(commitWorkflowInvocationFact({ ...fact, expectedContentRevision: 1n })).resolves.toMatchObject({ lifecycle: 'outcome_uncertain', contentRevision: '1' });
        await expect(commitWorkflowInvocationFact({ ...fact, expectedContentRevision: 1n,
            expectedLifecycle: 'completed' })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(parentBefore);
        expect(await db.workflowRunInvocation.count({ where: { runId: run.id } })).toBe(2);
    });
});
