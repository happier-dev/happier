import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AutomationRunCauseSchema } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { encodeAutomationRunCause, type CauseRow } from './automationRunCauseCodec';
import { isAutomationOriginRunPublisherTx } from './automationTriggerCauseChain';

const database = vi.hoisted(() => ({
    automationRun: { findUnique: vi.fn(), findFirst: vi.fn() },
    automationTrigger: { findFirst: vi.fn(async (args: { where: { automationId: string } }) => {
        // Prisma's non-null foreign-key query is the persistence boundary.
        if (!args.where.automationId) throw new Error('Invalid non-null Automation query');
        return null;
    }) },
}));
vi.mock('@/storage/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/storage/db')>(), db: database,
}));

beforeEach(() => {
    vi.clearAllMocks();
    database.automationRun.findUnique.mockResolvedValue({ accountId: 'account', sourceArtifactId: null,
        visibleTeamId: null, workflowAcceptedSnapshotEnvelope: null, workflowCustodyState: 'pending',
        account: { encryptionMode: 'plain' } });
});

it('refuses a scope-end publisher without its Automation correspondence instead of querying a nullable foreign key', async () => {
    const cause = encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'sessionLifecycle', triggerId: 'trigger',
        triggerRevision: 1, occurrenceKey: createHash('sha256').update('archive-occurrence').digest('base64url'), occurredAt: 1,
        evidence: { event: 'sessionArchived', sourceSessionId: 'session', policy: { kind: 'everyMatch' } } }));
    const row = { ...cause, originKind: 'automation', createdAt: new Date(1),
        id: 'run', state: 'running', automationId: null, executionInputEnvelope: 'opaque' } satisfies CauseRow & {
            id: string; state: string; automationId: string | null; executionInputEnvelope: string;
        };
    database.automationRun.findFirst.mockResolvedValue(row);
    await expect(isAutomationOriginRunPublisherTx(db, { accountId: 'account', machineId: 'machine',
        runId: 'run', requireCurrentScopeEnd: true })).resolves.toBe(false);
});

it.each([false, true])('retains direct Run publisher authority (scope-end=%s)', async requireCurrentScopeEnd => {
    const row = { ...encodeAutomationRunCause({ kind: 'manual', invokedAt: 1 }), originKind: 'direct',
        createdAt: new Date(1), id: 'run', state: 'running', automationId: null,
        executionInputEnvelope: 'opaque' } satisfies CauseRow & {
            id: string; state: string; automationId: string | null; executionInputEnvelope: string;
        };
    database.automationRun.findFirst.mockResolvedValue(row);
    await expect(isAutomationOriginRunPublisherTx(db, { accountId: 'account', machineId: 'machine',
        runId: 'run', requireCurrentScopeEnd })).resolves.toBe(true);
});
