import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { AuthContextType } from '@/auth/context/AuthContext';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Cold transformation belongs to collection; the factory itself resolves its real default owner.
await import('@/sync/ops/actions/defaultActionExecutor');
const { createScmDiffSummarySavedResultOperations } = await import('./savedResultOperations');
const marksPath = '/v1/kv/workspace%3Ascm-reviewed%3Av1%3Acomparison';
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
async function addHome() {
  const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account',
    serverIdentityId: 'srv_stable-home-a' });
  harness.answer(serverId, '/v1/account/encryption/currentness', { body: currentness });
  return serverId;
}

const listed = { success: true as const, results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved',
  revision: 1, comparisonId: 'comparison', source: { kind: 'workingTree' as const }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
  sevenDayCost: { status: 'unavailable' as const, pricedRunCount: 0, unpricedRunCount: 1, sinceMs: 0, untilMs: 1 } };
const input = { results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved', expectedRevision: 1, comparisonId: 'comparison' }] };
const savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'saved', revision: 1, canUndo: false,
  output: { success: true, resultId: 'saved', revision: 1, summaryMarkdown: 'Saved explanation', sourceKey: 'comparison',
    metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
    requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation' } } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
      inventory: { state: 'complete', files: [], reasons: [] } } } });

beforeEach(async () => { rpc.mockReset(); await harness.reset(); });
afterEach(() => standardCleanup());

describe('machine saved result operations', () => {
  it('preserves a typed disabled Clear outcome before cleanup or machine deletion', async () => {
    const actionExecutor = createActionExecutor({ isActionEnabled: () => false,
      scmActionExecute: async () => { throw new Error('Disabled Clear reached Machine transport'); },
    // Keep the real Action policy and schemas; only the Machine boundary is supplied.
    } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const operations = createScmDiffSummarySavedResultOperations({ machineId: 'machine', shouldContinue: () => true, actionExecutor });
    expect(await operations.clear(input)).toMatchObject({ success: false, errorCode: 'action_disabled' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses the combined Account cleanup workflow for API-token auth before any machine deletion', async () => {
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const previous = getCurrentAuth();
    setCurrentAuth({ isAuthenticated: true, credentials: { token: 'api-token' }, credentialAuthorityKind: 'api_token',
      login: async () => ({ kind: 'completed' }), loginWithCredentials: async () => ({ kind: 'completed' }),
      logout: async () => ({ kind: 'completed' }), refreshFromActiveServer: async () => {} } satisfies AuthContextType);
    try {
      // A stored normal Account can coexist with focused embedded API-token auth; both are environmental facts, not a UI-role grant.
      const serverId = await addHome();
      harness.answer(serverId, marksPath, { body: { key: 'workspace:scm-reviewed:v1:comparison', version: 1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: 'comparison', reviewedChangeRefs: [] } }) } });
      harness.answer(serverId, 'POST /v1/kv', { body: { success: true,
        results: [{ key: 'workspace:scm-reviewed:v1:comparison', version: 2 }] } });
      rpc.mockImplementation(async ({ method }) => method === 'scm.diffSummary.result.read' ? { success: true, result: savedResult }
        : { success: true, deleted: [{ success: true, resultId: 'saved', comparisonId: 'comparison' }], failures: [] });
      const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account',
        shouldContinue: () => true });
      expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
      expect(rpc).not.toHaveBeenCalled();
    } finally { setCurrentAuth(previous); }
  });

  it('retains machine inventory on Account cleanup failure and retries through the admitted terminal before deletion', async () => {
    let saved = true;
    let accountOffline = true;
    let currentResult = savedResult;
    let deletionRefused = false;
    const effects: string[] = [];
    let marks = { v: 1, comparisonId: 'comparison', reviewedChangeRefs: ['prior-change'] };
    const serverId = await addHome();
    harness.answer(serverId, 'POST /v1/kv', { select: input => {
        effects.push('marks');
        if (accountOffline) return { dispatchThenFail: true };
        const mutation = (input as { mutations: { key: string }[] }).mutations[0];
        marks = { ...marks, reviewedChangeRefs: [] };
        return { body: { success: true, results: [{ key: mutation.key, version: 2 }] } };
    } });
    harness.answer(serverId, marksPath, { select: () => ({ body: { key: 'workspace:scm-reviewed:v1:comparison',
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: marks }), version: 1 } }) });
    rpc.mockImplementation(async ({ method }) => {
      if (method === 'scm.diffSummary.result.list') return saved ? listed : { ...listed, results: [], count: 0, bytes: 0 };
      if (method === 'scm.diffSummary.result.read') return { success: true, result: currentResult };
      if (method === 'scm.diffSummary.result.clear') {
        if (deletionRefused) return { success: true, deleted: [], failures: [{ success: false, resultId: 'saved',
          errorCode: 'revision_conflict', error: 'A newer edit won', latestRevision: 2 }] };
        effects.push('delete'); saved = false;
        return { success: true, deleted: [{ success: true, resultId: 'saved', comparisonId: 'comparison' }], failures: [] };
      }
      throw new Error('Unexpected machine operation');
    });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account',
      shouldContinue: () => true });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [],
      failures: [{ resultId: 'saved', errorCode: 'result_unavailable' }] });
    expect(await ops.list()).toEqual(listed);
    expect(effects).toEqual(['marks']);
    accountOffline = false;
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [{ resultId: 'saved', marksCleanup: { success: true } }], failures: [] });
    expect((await ops.list())).toMatchObject({ success: true, count: 0 });
    expect(effects).toEqual(['marks', 'marks', 'delete']);
    saved = true;
    marks = { ...marks, reviewedChangeRefs: ['new-mark'] };
    currentResult = ScmDiffSummaryResultSchema.parse({ ...savedResult, revision: 2, output: { ...savedResult.output, revision: 2 } });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict', latestRevision: 2 }] });
    expect(effects).toEqual(['marks', 'marks', 'delete']);
    currentResult = ScmDiffSummaryResultSchema.parse({ ...savedResult, application: { acceptedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo', expectedHeadOid: null,
        expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
      status: 'applying', steps: [], nextGroupIndex: 0, stopAfterCurrent: false } });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'application_locked' }] });
    expect(effects).toEqual(['marks', 'marks', 'delete']);
    currentResult = savedResult;
    deletionRefused = true;
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict', latestRevision: 2 }] });
    expect(await ops.list()).toEqual(listed);
    expect(marks.reviewedChangeRefs).toEqual([]);
    expect(effects).toEqual(['marks', 'marks', 'delete', 'marks']);
  });
  it('rejects offline and retired inventory instead of reporting zero saved results', async () => {
    let current = true;
    const serverId = await addHome();
    rpc.mockImplementation(async () => { throw new Error('Owning machine offline'); });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => current });
    expect(await ops.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    rpc.mockImplementation(async () => { current = false; return listed; });
    const retiring = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => current });
    expect(await retiring.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });
  it('reports per-result cleanup failure while deleting only another explicitly approved result', async () => {
    const serverId = await addHome();
    const second = ScmDiffSummaryResultSchema.parse({ ...savedResult, resultId: 'second', output: { ...savedResult.output,
      resultId: 'second', sourceKey: 'second-comparison', metadata: { source: { kind: 'workingTree' }, sourceKey: 'second-comparison' },
      comparison: { ...savedResult.output.comparison, id: 'second-comparison' } } });
    const selected = { results: [...input.results, { ...input.results[0], resultId: 'second', comparisonId: 'second-comparison' }] };
    let firstSaved = true;
    let secondSaved = true;
    harness.answer(serverId, marksPath, { body: { key: 'workspace:scm-reviewed:v1:comparison', version: 1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: 'wrong-comparison', reviewedChangeRefs: ['untouched'] } }) } });
    harness.answer(serverId, '/v1/kv/workspace%3Ascm-reviewed%3Av1%3Asecond-comparison', { body: { key: 'workspace:scm-reviewed:v1:second-comparison', version: 1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: 'second-comparison', reviewedChangeRefs: ['reviewed'] } }) } });
    harness.answer(serverId, 'POST /v1/kv', { body: { success: true, results: [{ key: 'workspace:scm-reviewed:v1:second-comparison', version: 2 }] } });
    rpc.mockImplementation(async ({ method, payload }) => {
      if (method === 'scm.diffSummary.result.read') return { success: true, result: payload.resultId === 'second' ? second : savedResult };
      if (method === 'scm.diffSummary.result.clear') {
        // The machine accepts either a batch or one exact reference, just like the real RPC;
        // the caller-visible outcome must distinguish unsafe delete-first batching.
        for (const item of payload.results) {
          if (item.resultId === 'saved') firstSaved = false;
          if (item.resultId === 'second') secondSaved = false;
        }
        return { success: true, deleted: payload.results.map((item: { resultId: string; comparisonId: string }) => ({
          success: true, resultId: item.resultId, comparisonId: item.comparisonId,
        })), failures: [] };
      }
      if (method === 'scm.diffSummary.result.list') {
        const results = [...(firstSaved ? listed.results : []), ...(secondSaved ? [{ ...listed.results[0],
          resultId: 'second', comparisonId: 'second-comparison' }] : [])];
        return { ...listed, results, count: results.length, bytes: 12 * results.length };
      }
      throw new Error('Unexpected machine operation');
    });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account',
      shouldContinue: () => true });
    expect(await ops.clear(selected)).toMatchObject({ success: true,
      deleted: [{ resultId: 'second', comparisonId: 'second-comparison', marksCleanup: { success: true } }],
      failures: [{ resultId: 'saved', errorCode: 'result_unavailable' }] });
    expect(await ops.list()).toEqual(listed);
    expect(harness.requestsFor('/v1/kv').map(request => request.input)).toEqual([{ mutations: [{
      key: 'workspace:scm-reviewed:v1:second-comparison', version: 1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: 'second-comparison', reviewedChangeRefs: [] } }),
    }] }]);
  });
  it('uses shared Action approval before reaching the cleanup/deletion terminal', async () => {
    const serverId = await addHome();
    await harness.requireUiApproval(serverId, 'scm.diffSummary.result.clear');
    rpc.mockImplementation(async ({ method }) => method === 'scm.diffSummary.result.list' ? listed : undefined);
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await ops.list()).toEqual(listed);
    rpc.mockClear();
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(rpc).not.toHaveBeenCalled();
    expect(harness.requestsFor(marksPath)).toEqual([]);
    expect(harness.requestsFor('/v1/kv')).toEqual([]);
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
  });
});
