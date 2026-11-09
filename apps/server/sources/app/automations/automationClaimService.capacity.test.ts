import { beforeEach, expect, it, vi } from 'vitest';
import { matchesDbMockWhere, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';

const persistence = vi.hoisted(() => {
  const queries: Array<{ where: Record<string, unknown> }> = [];
  const runs: Array<Record<string, unknown> & { id: string }> = [];
  const eligibleIds: string[] = [];
  return { queries, runs, eligibleIds, tx: {} };
});
const transactions = await vi.hoisted(async () => {
  const { createDbTransactionMock } = await import('@/app/api/testkit/dbMocks');
  return createDbTransactionMock(() => persistence.tx);
});

// Only database transports are replaced; transaction orchestration, claim
// policy, Account fences and currentness derivation remain real.
vi.mock('@/storage/db', () => ({ db: transactions.wrapDb({}) }));
vi.mock('@/storage/prisma', async importOriginal => ({
  ...await importOriginal<typeof import('@/storage/prisma')>(),
  withSqliteReadSnapshot: transactions.readSnapshot,
}));

import { claimAutomationRun } from './automationClaimService';

beforeEach(() => {
  persistence.queries.length = 0;
  persistence.runs.length = 0;
  persistence.eligibleIds.length = 0;
  persistence.tx = {
    ...inTxPostgresControlStatementMock,
    $queryRawUnsafe: async () => [{ id: 'account' }],
    $executeRawUnsafe: async () => 1,
    account: { findUnique: async () => ({ seq: 1, encryptionMode: 'plain', publicKey: 'ab'.repeat(32),
      contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 }) },
    machine: { findFirst: async () => ({ id: 'machine', installationId: 'installation' }) },
    automationRun: { findMany: async (query: { where: Record<string, unknown> }) => {
      persistence.queries.push(query);
      if ('dueAt' in query.where) {
        persistence.eligibleIds = persistence.runs.filter(row => matchesDbMockWhere(row, query.where)).map(row => row.id);
      }
      // This boundary observes database candidate selection without leasing a Run.
      return [];
    } },
  };
});

it('selects private and session-scoped workflows plus unstarted manual/scheduled predecessor recipes', async () => {
  const now = Date.now();
  const workflow = { accountId: 'account', state: 'queued', originKind: 'direct',
    workflowCustodyState: 'pending', dueAt: new Date(now - 1), leaseExpiresAt: null,
    triggerId: null, assignments: [{ machineId: 'machine' }], automation: null };
  const predecessor = { ...workflow, workflowCustodyState: null, originKind: 'automation',
    causeKind: 'manual', causeTriggerKind: null, automation: { scopeSessionId: null },
    executionAttempt: 0, executionDispatchCommittedAt: null, executionNativeCallId: null,
    executionNativeRunId: null, executionNativeSidechainId: null, executionDispatchState: null,
    finishedAt: null, startedAt: null, producedSessionId: null, resultEnvelope: null,
    summaryCiphertext: null, workflowAcceptedSnapshotEnvelope: null, workflowCheckpointEnvelope: null,
    workflowInvocations: [], events: [] };
  persistence.runs = [
    { ...workflow, id: 'private-workflow' },
    { ...workflow, id: 'session-workflow', triggerId: 'trigger', automation: { scopeSessionId: 'session' } },
    { ...predecessor, id: 'manual-predecessor' },
    { ...predecessor, id: 'schedule-predecessor', causeKind: 'trigger', causeTriggerKind: 'schedule' },
    { ...predecessor, id: 'unsupported-predecessor', causeKind: 'trigger', causeTriggerKind: 'sessionTurnCompleted' },
    { ...predecessor, id: 'started-predecessor', events: [{ type: 'run_started' }] },
    { ...workflow, id: 'terminal-pending', state: 'cancelled' },
    { ...workflow, id: 'terminal-settled', state: 'cancelled', workflowCustodyState: 'settled' },
    { ...workflow, id: 'future', dueAt: new Date(now + 60_000) },
    { ...workflow, id: 'other-account', accountId: 'other-account' },
    { ...workflow, id: 'other-machine', assignments: [{ machineId: 'other-machine' }] },
    { ...workflow, id: 'leased', state: 'claimed', leaseExpiresAt: new Date(now + 60_000) },
  ];
  await expect(claimAutomationRun({ accountId: 'account', machineId: 'machine', leaseDurationMs: 30_000,
    scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: true } })).resolves.toEqual({ run: null, accountCurrentness: null });
  expect(persistence.eligibleIds).toEqual(['private-workflow', 'session-workflow', 'manual-predecessor', 'schedule-predecessor']);
});

it('does not turn a workflow-only claim into a legacy claim when Workflows is disabled', async () => {
  await expect(claimAutomationRun({ accountId: 'account', machineId: 'machine', leaseDurationMs: 30_000,
    scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: false } })).resolves.toEqual({ run: null, accountCurrentness: null });
  expect(persistence.queries).toEqual([]);
});
