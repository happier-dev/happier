import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const rpc = vi.hoisted(() => vi.fn());
// Session RPC is a transport boundary; the default Action executor and approval owner stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('@/sync/ops/actions/defaultActionExecutor');
const { createScmDiffSummaryResultOperations } = await import('./results');

beforeEach(async () => { rpc.mockReset(); await harness.reset(); });
afterEach(() => standardCleanup());

describe('commit proposal approval through the default Action executor', () => {
  it.each(['accept', 'includeHookChanges'] as const)('creates a genuine approval before %s can mutate', async (operation) => {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
      accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    await harness.requireUiApproval(serverId, `scm.diffSummary.commitPlan.${operation}`);
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', serverId, accountId: 'account',
      shouldContinue: () => true });
    const control = { cwd: '/repo', resultId: 'saved', expectedRevision: 1 };
    const request = () => operation === 'accept'
      ? ops.acceptCommitPlan({ ...control, acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo',
        expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main',
        groups: [{ id: 'one', message: 'First', rationale: '', changeRefs: ['exact'] }], leftOutChangeRefs: [] } })
      : ops.includeCommitPlanHookChanges({ ...control, groupId: 'one', beforeTreeOid: 'a'.repeat(40), afterTreeOid: 'b'.repeat(40) });
    const first = await request();
    expect(first).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
    const second = await request();
    expect(second).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(second).not.toEqual(first);
    expect(harness.artifacts(serverId).list()).toHaveLength(2);
    expect(rpc).not.toHaveBeenCalled();
  });
});
