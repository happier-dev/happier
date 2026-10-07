import { beforeEach, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ queries: [] as Array<{ where: Record<string, unknown> }> }));

// Transaction/database transport is the boundary. Claim policy, Account fences
// and currentness derivation remain the real production owners.
vi.mock('@/storage/inTx', () => ({
  afterTx: vi.fn(),
  inTx: async (operation: (tx: unknown) => Promise<unknown>) => operation({
    $queryRawUnsafe: async () => [{ id: 'account' }],
    $executeRawUnsafe: async () => 1,
    account: { findUnique: async () => ({ seq: 1, encryptionMode: 'plain', publicKey: 'ab'.repeat(32),
      contentPublicKey: null, contentPublicKeySig: null, settings: null, settingsVersion: 0 }) },
    machine: { findFirst: async () => ({ id: 'machine', installationId: 'installation' }) },
    automationRun: { findMany: async (query: { where: Record<string, unknown> }) => { persistence.queries.push(query); return []; } },
  }),
}));

import { claimAutomationRun } from './automationClaimService';

beforeEach(() => { persistence.queries.length = 0; });

it('selects private workflow recipes at full capacity without excluding Account destinations', async () => {
  await expect(claimAutomationRun({ accountId: 'account', machineId: 'machine', leaseDurationMs: 30_000,
    scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: true } })).resolves.toEqual({ run: null, accountCurrentness: null });
  const candidates = persistence.queries.find(query => 'dueAt' in query.where);
  expect(candidates?.where).toMatchObject({ workflowCustodyState: { not: null } });
  expect(candidates?.where).not.toHaveProperty('automation');
});

it('does not turn a workflow-only claim into a legacy claim when Workflows is disabled', async () => {
  await expect(claimAutomationRun({ accountId: 'account', machineId: 'machine', leaseDurationMs: 30_000,
    scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: false } })).resolves.toEqual({ run: null, accountCurrentness: null });
  expect(persistence.queries).toEqual([]);
});
