import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { deriveAutomationManualOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { encodeAutomationRunCause } from '@/app/automations/automationRunCauseCodec';
import { createDbMocks, createDbTransactionMock, inTxPostgresControlStatementMock, installDbModuleMock } from '@/app/api/testkit/dbMocks';
import { readRetentionPolicyFromEnv } from '../config/readRetentionPolicyFromEnv';

// Only the persistent database boundary is substituted; retention, transaction,
// Account-mode admission and immutable cause-chain interpretation stay real.
const mocks = createDbMocks({
    account: ['findUnique'],
    automationRun: ['findMany', 'findFirst', 'findUnique', 'deleteMany'],
    automation: ['findMany'],
    automationWorkerClaimReceipt: ['findMany', 'deleteMany'],
    sessionTurn: ['findMany'],
} as const);
const tx = { ...mocks.db, ...inTxPostgresControlStatementMock,
    $queryRawUnsafe: vi.fn(async () => [{ id: 'owner' }]),
};
installDbModuleMock({ db: createDbTransactionMock(() => tx).wrapDb(mocks.db) });
const { createAutomationRunRetentionRule } = await import('./automationRunRetentionRule');

const now = new Date('2026-11-15T00:00:00Z');
const old = new Date('2026-09-01T00:00:00Z');
const candidate = { id: 'parent', accountId: 'owner', automationId: null, revision: 1,
    finishedAt: old, automation: null, account: { automationRunRetention: 'thirtyDays' } };

describe('Run retention with live cause ancestors', () => {
    beforeEach(() => {
        mocks.reset();
        mocks.db.account.findUnique.mockResolvedValue({ encryptionMode: 'plain', publicKey: null,
            contentPublicKey: null, contentPublicKeySig: null, seq: 0, settings: null, settingsVersion: 0 });
        mocks.db.automationWorkerClaimReceipt.findMany.mockResolvedValue([]);
        mocks.db.automationWorkerClaimReceipt.deleteMany.mockResolvedValue({ count: 0 });
        mocks.db.automation.findMany.mockResolvedValue([]);
        mocks.db.automationRun.findMany.mockImplementation(async (query) => query.where.NOT ? [{ id: 'child' }] : [candidate]);
        mocks.db.automationRun.findFirst.mockResolvedValue(candidate);
        mocks.db.sessionTurn.findMany.mockResolvedValue([]);
        const child = encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: 'trigger',
            triggerKind: 'runLifecycle', triggerId: 'trigger', triggerRevision: 1,
            occurrenceKey: deriveAutomationManualOccurrenceKeyV1({ automationId: 'automation', idempotencyKey: 'child' }),
            occurredAt: now.getTime(), evidence: { source: { kind: 'workflow_run', runId: 'parent' },
                condition: 'terminal', sourceRevision: 1 },
        }));
        mocks.db.automationRun.findUnique.mockImplementation(async ({ where }) => where.id === 'child'
            ? { ...child, originKind: 'automation', automationId: 'automation' } : { originKind: 'direct' });
        mocks.db.automationRun.deleteMany.mockImplementation(async () => {
            throw new Error('retention attempted to erase a live publisher ancestor');
        });
    });

    it.each([false, true])('preserves an expired settled ancestor while its descendant still publishes (dry run: %s)', async dryRun => {
        const policy = readRetentionPolicyFromEnv({});
        await expect(createAutomationRunRetentionRule().run({ policy, batchSize: 10,
            maxDeletesPerRulePerRun: 10, dryRun, now })).resolves.toMatchObject({ deleted: 0 });
        expect(mocks.db.automationRun.deleteMany).not.toHaveBeenCalled();
    });

    it('makes expired history eligible again after the last publisher settles', async () => {
        mocks.db.automationRun.findMany.mockImplementation(async query => query.where.NOT ? [] : [candidate]);
        await expect(createAutomationRunRetentionRule().run({ policy: readRetentionPolicyFromEnv({}), batchSize: 10,
            maxDeletesPerRulePerRun: 10, dryRun: true, now })).resolves.toMatchObject({ deleted: 1 });
        expect(mocks.db.automationRun.deleteMany).not.toHaveBeenCalled();
    });
});
