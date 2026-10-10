import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import type { ScmComparison } from '@happier-dev/protocol/scm';

const rpc = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
// Session RPC is a transport boundary; the default Action executor and approval owner stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: rpc }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('@/sync/ops/actions/defaultActionExecutor');
const { createScmDiffSummaryResultOperations } = await import('./results');

beforeEach(async () => { rpc.mockReset(); machineRpc.mockReset(); await harness.reset(); });
afterEach(() => standardCleanup());

describe('commit proposal approval through the default Action executor', () => {
  it.each([true, false])('keeps an acknowledged SCM mutation truthful after Account retirement (success=%s)', async (success) => {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
      accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
    const receipt = success ? { success: true, commitSha: 'a'.repeat(40) }
      : { success: false, errorCode: 'COMMAND_FAILED', error: 'The commit was refused.' };
    machineRpc.mockImplementation(async () => {
      await harness.switchAccount(serverId, 'replacement-account');
      return receipt;
    });
    const { machineScmCommitCreate } = await import('@/sync/ops/scm/machineScm');
    expect(await machineScmCommitCreate('machine', { cwd: '/repo', message: 'Captured commit' }, {
      serverId, accountId: 'account',
    })).toMatchObject(receipt);
  });
  it('does not disclose a saved-result read after the captured Account retires', async () => {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
      accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
    machineRpc.mockImplementation(async () => {
      await harness.switchAccount(serverId, 'replacement-account');
      return { success: true, result: { resultId: 'private-saved', revision: 0, canUndo: false,
        output: { success: true, resultId: 'private-saved', revision: 0, sourceKey: 'private-comparison', summaryMarkdown: 'Private saved content',
          metadata: { sourceKey: 'private-comparison', source: { kind: 'workingTree' } },
          requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
          analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } } };
    });
    const operations = createScmDiffSummaryResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    const response = await operations.read({ cwd: '/repo', resultId: 'private-saved' });
    expect(response.success).toBe(false);
    expect(response).not.toHaveProperty('result');
  });
  it('marks captured Files without a saved result through admitted Machine evidence and the captured Account', async () => {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
      accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    const comparison: ScmComparison = { id: 'c'.repeat(64), source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
      endpoints: { before: 'before', after: 'after' }, inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts',
        changeKind: 'modified', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: 'patch' },
        occurrences: [{ id: 'exact', alias: 'c0', path: 'a.ts', position: 0, before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
      }] } };
    const key = `workspace:scm-reviewed:v1:${comparison.id}`;
    harness.answer(serverId, `/v1/kv/${encodeURIComponent(key)}`, { body: { key, version: 1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: [] } }) } });
    harness.answer(serverId, 'POST /v1/kv', { body: { success: true, results: [{ key, version: 2 }] } });
    machineRpc.mockImplementation(async ({ method }) => method === 'scm.diffSummary.capture'
      ? { success: true, comparison, metadata: { source: comparison.source, sourceKey: comparison.id } }
      : { success: false, errorCode: 'result_unavailable', error: 'No saved narration exists' });
    const operations = createScmDiffSummaryResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await operations.setReviewed({ v: 2, cwd: '/repo', comparisonId: comparison.id, source: comparison.source, changeRefs: ['exact'] }, true))
      .toMatchObject({ success: true, record: { comparisonId: comparison.id, reviewedChangeRefs: ['exact'] } });
    expect(machineRpc.mock.calls.every(([request]) => request.method === 'scm.diffSummary.capture')).toBe(true);
    expect(harness.requestsFor('/v1/kv').map(request => request.input)).toEqual([{ mutations: [{ key, version: 1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: ['exact'] } }),
    }] }]);
  });
  it('holds a no-Session manual commit behind its configured Action approval before dispatch', async () => {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example',
      accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    await harness.requireUiApproval(serverId, 'scm.commit.create');
    machineRpc.mockResolvedValue({ success: true, commitSha: 'a'.repeat(40) });
    const { machineScmCommitCreate } = await import('@/sync/ops/scm/machineScm');
    expect(await machineScmCommitCreate('machine', { cwd: '/repo', message: 'Intentional commit' }, {
      serverId, accountId: 'account',
    })).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED', actionErrorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(machineRpc).not.toHaveBeenCalled();
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
  });
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
