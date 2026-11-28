import { afterEach, expect, it, vi } from 'vitest';
import { sealAutomationRunFailureDetailStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationRunFailureDetailStoredContent';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { WorkflowStoredContentEnvelopeV1Schema } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';

const boundary = await vi.hoisted(async () => {
    const { createDbMaintenanceClient } = await import('@/storage/prisma');
    // Prisma field references do not open a connection; the unreachable URL is never used.
    const client = await createDbMaintenanceClient('postgres', 'postgresql://fields:fields@127.0.0.1:1/fields');
    return { tx: {}, fields: client.automationRun.fields };
});
const transactions = await vi.hoisted(async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import('@/app/api/testkit/dbMocks');
    return createDbTransactionMock(() => ({ ...inTxPostgresControlStatementMock, ...boundary.tx }));
});
// The only substitute is the database transport; transaction lifecycle, locking,
// currentness, envelopes and terminal publication execute their real owners.
vi.mock('@/storage/db', async original => ({
    ...await original<typeof import('@/storage/db')>(),
    db: transactions.wrapDb({ automationRun: { fields: boundary.fields } }),
}));
vi.mock('@/storage/prisma', async original => ({
    ...await original<typeof import('@/storage/prisma')>(), withSqliteReadSnapshot: transactions.readSnapshot,
}));
import { commitWorkflowInvocationFact, getCurrentWorkflowRunInvocation, getWorkflowRun, getWorkflowRunControl, getWorkflowRunInvocation, listWorkflowRunInvocations } from './workflowRunService';

afterEach(() => vi.unstubAllEnvs());

it('commits an idempotent invocation fact with constant query cost across assigned targets', async () => {
    vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
    vi.stubEnv('HAPPY_DB_PROVIDER', 'postgres');
    vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
    const accountId = 'owner';
    const runId = '11111111-1111-4111-8111-111111111111';
    const invocationId = '22222222-2222-4222-8222-222222222222';
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
            recordId: invocationId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
            blockKind: 'root', attempt: '0', logicalInvocationRecordId: invocationId },
    }));
    const counts: number[] = [];
    for (const size of [1, 100]) {
        let queries = 0;
        const read = <T>(value: T) => async () => { queries++; return value; };
        const now = new Date();
        const run = { id: runId, accountId, originKind: 'direct', automationId: null, causeKind: null,
            sourceArtifactId: null, visibleTeamId: null, originSessionId: null, producedSessionId: null,
            executionInputEnvelope: null, account: { encryptionMode: 'plain' }, workflowCustodyState: 'pending',
            state: 'running', revision: 1, attempt: 0, claimedByMachineId: 'm0', originDeliveryAckRevision: null,
            assignments: Array.from({ length: size }, (_, i) => ({ machineId: `m${i}` })) };
        const invocation = { id: invocationId, runId, sequence: 0n, parentRecordId: null, memberOrdinal: 0n,
            attempt: 0n, contentRevision: 0n, lifecycle: 'running', contentEnvelope: envelope, createdAt: now, updatedAt: now };
        boundary.tx = {
            $queryRawUnsafe: async (query: string) => {
                queries++;
                if (query.includes('FROM "ManagedMachine"')) return [];
                if (query.includes('FROM "Machine"')) return [{ accountId }];
                return [{ id: accountId }];
            },
            account: { findUnique: read({ id: accountId, seq: 1, publicKey: 'ab'.repeat(32), encryptionMode: 'plain',
                contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 }) },
            automationRun: { findMany: read([run]), findFirst: read(run), findUniqueOrThrow: read(run) },
            automationTrigger: { findMany: read([]) },
            sessionFollowEdge: { findMany: read([]) },
            session: { findMany: read([]) },
            machine: { findMany: read([{ accountId }]) },
            managedMachine: { findFirst: read(null), findMany: read([]) },
            workflowRunInvocation: { findFirst: async ({ where }: { where: { attempt?: unknown } }) => {
                queries++;
                return typeof where.attempt === 'object' ? null : invocation;
            } },
        };
        const result = await commitWorkflowInvocationFact({ accountId, runId, machineId: 'm0', parentAttempt: 0,
            invocationId, invocationAttempt: 0n, expectedContentRevision: 0n, expectedLifecycle: 'running',
            lifecycle: 'running', contentEnvelope: envelope,
            accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        expect(result.parentRevision).toBe(1);
        counts.push(queries);
    }
    console.info('INVOCATION_FACT_COMMIT_QUERIES', counts);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(10);
});

function retainedInvocationFixture() {
    const accountId = 'owner';
    const runId = '11111111-1111-4111-8111-111111111111';
    const invocationId = '22222222-2222-4222-8222-222222222222';
    const parentRecordId = '33333333-3333-4333-8333-333333333333';
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
            recordId: invocationId, sequence: '1', parentRecordId, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'step', scope: [] },
            blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocationId },
    }));
    const now = new Date();
    const account = { id: accountId, seq: 1, publicKey: 'ab'.repeat(32), encryptionMode: 'plain',
        contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 };
    const run = { id: runId, accountId, account, sourceArtifactId: null, visibleTeamId: null,
        workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: 'accepted' as string | null, state: 'running', revision: 7,
        automationId: 'automation-1', errorCode: null as string | null, errorMessage: null as string | null };
    const invocation = { id: invocationId, runId, sequence: 1n, parentRecordId, memberOrdinal: 0n,
        attempt: 0n, contentRevision: 1n, lifecycle: 'running', contentEnvelope, createdAt: now, updatedAt: now };
    const parentRead = vi.fn(async ({ select, where }: {
        select: Record<string, unknown>;
        where?: { workflowCustodyState?: { not: null }; workflowAcceptedSnapshotEnvelope?: { not: null } };
    }) => {
        if (where?.workflowAcceptedSnapshotEnvelope && run.workflowAcceptedSnapshotEnvelope === null) return null;
        return Object.fromEntries(Object.entries(run).filter(([key]) => select[key]));
    });
    boundary.tx = {
        automationRun: { findMany: async (args: Parameters<typeof parentRead>[0]) => [await parentRead(args)],
            findFirst: parentRead, findUnique: parentRead },
        account: { findMany: async () => [account] },
        workflowRunDataKeyEnvelope: { findMany: async () => [] },
        workflowRunInvocation: { findFirst: async () => invocation },
    };
    return { invocation, parentRead, run, accountId, runId, invocationId, parentRecordId };
}

it('reads the admitted Workflow parent once per exact control or invocation intent', async () => {
    const { parentRead, run, accountId, runId, invocationId, parentRecordId } = retainedInvocationFixture();
    const exact = await getWorkflowRunInvocation({ accountId, runId, invocationId });
    expect(exact.invocation.parentRevision).toBe(7);
    const exactReads = parentRead.mock.calls.length;
    parentRead.mockClear();
    const current = await getCurrentWorkflowRunInvocation({ accountId, runId, parentRecordId, memberOrdinal: 0n });
    expect(current).toMatchObject({ parentRevision: 7, invocation: { index: { id: invocationId } } });
    const currentReads = parentRead.mock.calls.length;
    parentRead.mockClear();
    const control = await getWorkflowRunControl({ accountId, runId, projection: 'revision' });
    expect(control).toEqual({ run: { state: 'running', revision: 7 } });
    console.info('RETAINED_WORKFLOW_PARENT_READS', { exact: exactReads, current: currentReads, control: parentRead.mock.calls.length });
    expect([exactReads, currentReads, parentRead.mock.calls.length]).toEqual([1, 1, 1]);
    run.workflowAcceptedSnapshotEnvelope = null;
    await expect(getWorkflowRunControl({ accountId, runId, projection: 'revision' }))
        .rejects.toMatchObject({ code: 'run_not_found' });
    await expect(getWorkflowRunInvocation({ accountId: 'other', runId, invocationId }))
        .rejects.toMatchObject({ code: 'run_not_found' });
});

it('returns a failed Run’s private pre-execution refusal only on its requester’s exact content reads', async () => {
    const { run, accountId, runId, invocationId } = retainedInvocationFixture();
    const envelope = JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({ mode: 'plain',
        correspondence: { automationId: run.automationId, runId }, detail: 'Private detail',
        failureCause: { phase: 'workflow.trigger_admission', errorClass: 'Error', errorCode: 'target_unavailable',
            httpStatus: null, diagnostic: { reason: 'session_unavailable' } },
    }));
    Object.assign(run, { workflowAcceptedSnapshotEnvelope: null, state: 'failed', errorCode: 'target_unavailable', errorMessage: envelope });
    const reads = (actor: string) => [
        () => getWorkflowRun({ accountId: actor, runId }),
        () => getWorkflowRunInvocation({ accountId: actor, runId, invocationId }),
        () => listWorkflowRunInvocations({ accountId: actor, runId, progressEnvelopes: true, pageByteLimit: 4096 }),
    ];
    for (const read of reads(accountId)) {
        await expect(read()).rejects.toMatchObject({ code: 'target_unavailable',
            preExecutionFailure: { automationId: run.automationId, envelope } });
    }
    for (const read of reads('machine-owner-other-account')) {
        await expect(read()).rejects.toMatchObject({ code: 'run_not_found' });
    }
});

it('validates the stored outer envelope schema once per disclosed invocation', async () => {
    const { invocation, accountId, runId, invocationId } = retainedInvocationFixture();
    const outer = vi.spyOn(createStoredReadSchema(WorkflowStoredContentEnvelopeV1Schema)._zod, 'run');
    try {
        const result = await getWorkflowRunInvocation({ accountId, runId, invocationId });
        expect(result.invocation.contentEnvelope).toBe(invocation.contentEnvelope);
        console.info('RETAINED_WORKFLOW_OUTER_ENVELOPE_PARSES', outer.mock.calls.length);
        expect(outer).toHaveBeenCalledTimes(1);
        invocation.contentEnvelope = '{"t":"encrypted","c":3}';
        await expect(getWorkflowRunInvocation({ accountId, runId, invocationId })).rejects.toMatchObject({ code: 'invalid_input' });
        invocation.contentEnvelope = '{';
        await expect(getWorkflowRunInvocation({ accountId, runId, invocationId })).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
        outer.mockRestore();
    }
});
