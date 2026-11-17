import { afterEach, expect, it, vi } from 'vitest';
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
import { commitWorkflowInvocationFact } from './workflowRunService';

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
});
