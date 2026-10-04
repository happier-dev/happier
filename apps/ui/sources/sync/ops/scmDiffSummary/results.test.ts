import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryResultResponseSchema, type ScmDiffSummaryResultResponse } from '@happier-dev/protocol/scm';
import { createScmDiffSummaryResultOperations } from './results';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

const result = ScmDiffSummaryResultResponseSchema.options[0].parse({ success: true, result: { resultId: 'saved', revision: 0, canUndo: false,
  output: { success: true, resultId: 'saved', revision: 0, sourceKey: 'comparison', metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
    requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } },
} });
describe('saved SCM result client operations', () => {
  it('admits acceptance through real Action policy and never falls back to direct mutation RPC', async () => {
    const calls: string[] = [];
    // The RPC is the only exercised system boundary; Action admission and schemas are real.
    const executor = createActionExecutor({ isActionApprovalRequired: () => true,
      scmActionExecute: async () => { calls.push('writer'); return result; },
    // This fixture supplies only the exercised RPC boundary; unrelated transports are never invoked.
    } as unknown as ActionExecutorDeps);
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
      actionExecutor: executor, rpc: async () => { calls.push('unsafe-rpc'); return result; } });
    expect(await ops.acceptCommitPlan({ cwd: '/repo', resultId: 'saved', expectedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', groups: [{ id: 'one', message: 'First', rationale: '', changeRefs: ['exact'] }], leftOutChangeRefs: [] },
    })).toMatchObject({ success: false, errorCode: 'approvals_not_supported' });
    expect(calls).toEqual([]);
  });
  it('preserves current accepted application in result reads and scoped Stop/Cancel/Recover responses', async () => {
    const calls: string[] = [];
    const applicationResult = ScmDiffSummaryResultResponseSchema.parse({ ...result, result: { ...result.result,
      application: { acceptedRevision: 0, acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', groups: [{ id: 'one', message: 'First', rationale: '', changeRefs: ['exact'] }], leftOutChangeRefs: [] },
        status: 'unknown', steps: [{ groupId: 'one', state: 'unknown', commitSha: 'b'.repeat(40), actualMessage: 'Hook message' }], nextGroupIndex: 0, stopAfterCurrent: true, reason: 'outcome_unknown' } } });
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
      rpc: async (method) => { calls.push(method); return applicationResult; } });
    const input = { cwd: '/repo', resultId: 'saved', expectedRevision: 0 };
    for (const operation of [ops.stopCommitPlan, ops.cancelCommitPlan, ops.recoverCommitPlan]) expect(await operation(input)).toEqual(applicationResult);
    expect(await ops.read({ cwd: '/repo', resultId: 'saved' })).toEqual(applicationResult);
    expect(calls).toEqual(['scm.diffSummary.commitPlan.stop', 'scm.diffSummary.commitPlan.cancel', 'scm.diffSummary.commitPlan.recover', 'scm.diffSummary.result.read']);
  });
  it('uses exact displayed hook trees through the real Action owner and suppresses a retired admission', async () => {
    const admitted: unknown[] = [];
    let writerResult: ScmDiffSummaryResultResponse = result;
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      scmActionExecute: async ({ input, context }: Parameters<NonNullable<ActionExecutorDeps['scmActionExecute']>>[0]) => { admitted.push({ input, target: context.externalActionTarget }); return writerResult; },
    // This fixture supplies only the exercised RPC boundary; unrelated transports are never invoked.
    } as unknown as ActionExecutorDeps);
    let current = true;
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', serverId: 'home', accountId: 'account',
      shouldContinue: () => current, actionExecutor: executor, rpc: async () => { throw new Error('Unsafe mutation RPC'); } });
    const input = { cwd: '/repo', resultId: 'saved', expectedRevision: 0, groupId: 'one', beforeTreeOid: 'a'.repeat(40), afterTreeOid: 'b'.repeat(40) };
    expect(await ops.includeCommitPlanHookChanges(input)).toEqual(result);
    expect(admitted).toEqual([{ input, target: { kind: 'session', sessionId: 'session' } }]);
    writerResult = ScmDiffSummaryResultResponseSchema.parse({ success: false, errorCode: 'source_changed', error: 'The displayed hook trees changed.', latestRevision: 1 });
    expect(await ops.includeCommitPlanHookChanges(input)).toEqual(writerResult);
    current = false;
    expect(await ops.includeCommitPlanHookChanges(input)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(admitted).toHaveLength(2);
  });
  it('preserves a revision conflict and caller draft instead of resubmitting stale edits', async () => {
    const draft = { cwd: '/repo', resultId: 'saved', expectedRevision: 0, edit: { kind: 'renameWalkthrough' as const, title: 'My draft' } };
    const calls: unknown[] = [];
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
      rpc: async (method, input) => { calls.push({ method, input }); return { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 1 }; } });
    expect(await ops.edit(draft)).toEqual({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 1 });
    expect(calls).toEqual([{ method: 'scm.diffSummary.result.edit', input: draft }]);
    expect(draft.edit.title).toBe('My draft');
  });
  it('retires an in-flight response when the captured Account or Session changes', async () => {
    let current = true;
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => current,
      rpc: async () => { current = false; return result; } });
    expect(await ops.read({ cwd: '/repo', resultId: 'saved' })).toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });
  it('preserves the owning machine deletion and revision-conflict outcomes', async () => {
    let deleted = false;
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
      rpc: async () => deleted ? { success: true, resultId: 'saved', comparisonId: 'comparison' }
        : { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 1 } });
    expect(await ops.delete({ cwd: '/repo', resultId: 'saved', expectedRevision: 0 })).toEqual({ success: false,
      errorCode: 'revision_conflict', error: 'Changed', latestRevision: 1 });
    deleted = true;
    expect(await ops.delete({ cwd: '/repo', resultId: 'saved', expectedRevision: 1 })).toEqual({ success: true,
      resultId: 'saved', comparisonId: 'comparison' });
  });
});
