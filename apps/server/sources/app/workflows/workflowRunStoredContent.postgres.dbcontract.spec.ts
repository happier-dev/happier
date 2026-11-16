import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { WORKFLOW_RUN_CIPHERTEXT_PREFIX } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol/workflows';
import { db, initDbPostgres } from '@/storage/db';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import {
    admitWorkflowInvocations, getWorkflowRun, initializeWorkflowRunExecution,
    pullWorkflowRunOriginDelivery, recoverWorkflowInvocations, transitionWorkflowRun, waitWorkflowRun,
} from './workflowRunService';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Workflow Run stored ciphertext (real PostgreSQL)', () => {
    const accountIds: string[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        // Temporary disposable-schema bridge until the additive migration lands.
        for (const [table, column] of [['Session', 'metadataBytes'], ['Session', 'agentStateBytes'],
            ['Machine', 'metadataBytes'], ['Machine', 'daemonStateBytes'], ['SessionSystemRecord', 'contentBytes'],
            ['AutomationRun', 'resultEnvelopeBytes'], ['AutomationRun', 'workflowCheckpointEnvelopeBytes'],
            ['AccountSettingsSnapshot', 'settingsDbValueBytes']]) {
            await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" BYTEA`);
        }
    });
    afterAll(async () => {
        await db.automationRun.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        await db.$disconnect();
    });

    async function fixture(mode: 'plain' | 'e2ee') {
        const signing = tweetnacl.sign.keyPair();
        const contentPublicKey = new Uint8Array(tweetnacl.box.keyPair().publicKey);
        const account = await db.account.create({ data: {
            encryptionMode: mode,
            ...(mode === 'e2ee' ? { publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } : {}),
        } });
        accountIds.push(account.id);
        const accountId = account.id;
        const machineId = randomUUID();
        const runId = randomUUID();
        const rootId = randomUUID();
        const sealMode = mode === 'plain' ? { mode } as const
            : { mode, runDataKey: tweetnacl.randomBytes(32), randomBytes: tweetnacl.randomBytes } as const;
        const binding = { v: 1 as const, accountId, runId };
        await db.machine.create({ data: { id: machineId, accountId, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode: mode, metadata: '{}' } });
        const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'answer',
                document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', originSessionId: session.id }, authorization: { principal: { kind: 'host' } } },
        });
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            ...sealMode, binding: { ...binding, purpose: 'accepted_snapshot' }, acceptedSnapshot: snapshot,
        }));
        await db.automationRun.create({ data: { id: runId, accountId, originKind: 'direct', causeKind: null,
            state: 'running', attempt: 1, claimedByMachineId: machineId, scheduledAt: new Date(), dueAt: new Date(),
            originSessionId: session.id, originDeliveryAckRevision: 0, workflowCustodyState: 'pending',
            workflowAcceptedSnapshotEnvelope: acceptedEnvelope, assignments: { create: { machineId, priority: 0 } },
        } });
        const currentness = async () => {
            const witness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: automationAccountCurrentnessSelect }));
            if (!witness) throw new Error('Fixture currentness unavailable');
            return witness;
        };
        const checkpoint = (nextSequence: number) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
            ...sealMode, binding: { ...binding, purpose: 'checkpoint' },
            checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: String(nextSequence),
                frontier: { nextBlockOrdinal: nextSequence, paused: false } },
        }));
        const progress = (id: string, sequence: number, parentRecordId: string | null, attempt = 0, previousAttemptRecordId?: string) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            ...sealMode, binding: { ...binding, purpose: 'invocation_progress', recordId: id, sequence: String(sequence), parentRecordId, memberOrdinal: '0', attempt: String(attempt) },
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: parentRecordId ? 'step' : '$root', scope: [] },
                blockKind: parentRecordId ? 'step' : 'root', attempt: String(attempt), logicalInvocationRecordId: previousAttemptRecordId ?? id,
                ...(previousAttemptRecordId ? { previousAttemptRecordId } : {}) },
        }));
        return { accountId, runId, machineId, rootId, originSessionId: session.id, checkpoint, progress, currentness, sealMode, binding };
    }

    async function expectStored(runId: string, field: 'resultEnvelope' | 'workflowCheckpointEnvelope', envelope: string, mode: 'plain' | 'e2ee') {
        const row = await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: {
            resultEnvelope: true, resultEnvelopeBytes: true, workflowCheckpointEnvelope: true, workflowCheckpointEnvelopeBytes: true,
        } });
        const bytes = field === 'resultEnvelope' ? row.resultEnvelopeBytes : row.workflowCheckpointEnvelopeBytes;
        if (mode === 'plain') {
            expect(row[field]).toBe(envelope);
            expect(bytes).toBeNull();
        } else {
            const original = JSON.parse(envelope);
            expect(row[field]).toBe(JSON.stringify({ ...original, c: WORKFLOW_RUN_CIPHERTEXT_PREFIX }));
            expect(bytes).toEqual(new Uint8Array(privacyKit.decodeBase64(original.c.slice(WORKFLOW_RUN_CIPHERTEXT_PREFIX.length))));
            const [sample] = await db.$queryRawUnsafe<Array<{ beforeBytes: number; afterBytes: number }>>(
                `SELECT pg_column_size($1::text)::integer AS "beforeBytes", (pg_column_size("${field}") + pg_column_size("${field}Bytes"))::integer AS "afterBytes" FROM "AutomationRun" WHERE "id" = $2`, envelope, runId);
            console.info('WORKFLOW_STORED_CIPHERTEXT_SAMPLE', { field, ...sample });
        }
    }

    it.each(['plain', 'e2ee'] as const)('stores %s checkpoints/results and restores reads, replay and origin delivery', async mode => {
        const f = await fixture(mode);
        const initial = { ...f, parentAttempt: 1, expectedRevision: 0, checkpointEnvelope: f.checkpoint(1),
            rootInvocation: { id: f.rootId, contentEnvelope: f.progress(f.rootId, 0, null) }, accountCurrentness: await f.currentness() };
        await initializeWorkflowRunExecution(initial);
        await expectStored(f.runId, 'workflowCheckpointEnvelope', initial.checkpointEnvelope, mode);
        expect((await initializeWorkflowRunExecution({ ...initial, accountCurrentness: await f.currentness() })).initialization).toBe('existing');
        const childId = randomUUID();
        const admitted = { ...f, parentAttempt: 1, expectedRevision: 1, checkpointEnvelope: f.checkpoint(2),
            invocations: [{ id: childId, sequence: 1n, parentRecordId: f.rootId, memberOrdinal: 0n, contentEnvelope: f.progress(childId, 1, f.rootId) }], accountCurrentness: await f.currentness() };
        await admitWorkflowInvocations(admitted);
        await expectStored(f.runId, 'workflowCheckpointEnvelope', admitted.checkpointEnvelope, mode);
        expect((await admitWorkflowInvocations({ ...admitted, accountCurrentness: await f.currentness() })).disposition).toBe('existing');
        const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({ ...f.sealMode,
            binding: { ...f.binding, purpose: 'final_result' }, finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'done' }, producerInvocation: { recordId: childId } },
        }));
        await transitionWorkflowRun({ ...f, parentAttempt: 1, expectedRevision: 2, state: 'succeeded', checkpointEnvelope: admitted.checkpointEnvelope,
            resultEnvelope, accountCurrentness: await f.currentness(), invocationTransitions: [f.rootId, childId].map(id => ({
                id, expectedLifecycle: 'pending' as const, lifecycle: 'completed' as const, expectedContentRevision: 0n,
            })) });
        await expectStored(f.runId, 'resultEnvelope', resultEnvelope, mode);
        await transitionWorkflowRun({ ...f, parentAttempt: 1, expectedRevision: 3, state: 'succeeded', custodyState: 'settled',
            checkpointEnvelope: admitted.checkpointEnvelope, resultEnvelope, accountCurrentness: await f.currentness() });
        expect(await getWorkflowRun(f)).toMatchObject({ checkpointEnvelope: admitted.checkpointEnvelope, resultEnvelope });
        expect(await waitWorkflowRun({ ...f, conditions: ['terminal'], timeoutSeconds: 0 })).toMatchObject({ observation: 'terminal', resultEnvelope });
        expect((await pullWorkflowRunOriginDelivery({ ...f, pageByteLimit: 1_000_000 })).runs).toEqual([
            expect.objectContaining({ checkpointEnvelope: admitted.checkpointEnvelope, resultEnvelope }),
        ]);
        // Legacy text rows remain readable alongside the new byte representation.
        await db.automationRun.update({ where: { id: f.runId }, data: { workflowCheckpointEnvelope: admitted.checkpointEnvelope,
            workflowCheckpointEnvelopeBytes: null, resultEnvelope, resultEnvelopeBytes: null } });
        expect(await getWorkflowRun(f)).toMatchObject({ checkpointEnvelope: admitted.checkpointEnvelope, resultEnvelope });
    });

    it('stores and rejoins a recovered encrypted checkpoint', async () => {
        const f = await fixture('e2ee');
        await db.automationRun.update({ where: { id: f.runId }, data: { state: 'interrupted', workflowCheckpointEnvelope: f.checkpoint(1) } });
        const childId = randomUUID();
        const nextId = randomUUID();
        await db.workflowRunInvocation.create({ data: { id: childId, runId: f.runId, sequence: 0n, memberOrdinal: 0n,
            lifecycle: 'failed', contentEnvelope: f.progress(childId, 0, null) } });
        const recovery = { ...f, expectedRevision: 0, checkpointEnvelope: f.checkpoint(2), accountCurrentness: await f.currentness(),
            recoveries: [{ invocationId: childId, newInvocationId: nextId, contentEnvelope: f.progress(nextId, 1, null, 1, childId) }] };
        await recoverWorkflowInvocations(recovery);
        await expectStored(f.runId, 'workflowCheckpointEnvelope', recovery.checkpointEnvelope, 'e2ee');
        expect((await recoverWorkflowInvocations({ ...recovery, accountCurrentness: await f.currentness() })).disposition).toBe('existing');
    });
});
