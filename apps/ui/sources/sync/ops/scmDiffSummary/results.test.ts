import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryResultResponseSchema, type ScmDiffSummaryResultResponse } from '@happier-dev/protocol/scm';
import { SessionDraftRecipientValueV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createScmDiffSummaryResultOperationsWithTransport as createScmDiffSummaryResultOperations } from '@/dev/testkit/harness/scmActionTransport';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { t } from '@/text';
import { createDeferred } from '@/dev/testkit';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const result = ScmDiffSummaryResultResponseSchema.def.options[0].parse({ success: true, result: { resultId: 'saved', revision: 0, canUndo: false,
  output: { success: true, resultId: 'saved', revision: 0, sourceKey: 'comparison', metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
    requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } },
} });
describe('saved SCM result client operations', () => {
  it.each([false, true])('settles admitted discussion routing after presentation retirement while fencing Account retirement (%s)', async retireAccount => {
    const scope = { serverId: 'srv_result_draft', accountId: 'account' };
    const account = await activateStorageAccountScope(scope);
    try {
      const scopeLifetime = captureActiveServerAccountScopeLifetime();
      if (!scopeLifetime) throw new Error('Expected the fixture Account lifetime');
      const target = { cwd: '/repo', resultId: 'saved', expectedRevision: 0, startNew: true };
      const recipient = SessionDraftRecipientValueV1Schema.parse({ mode: 'scm_diff_summary', recipient: null, target });
      writeExistingSessionDraft({ scope, sessionId: 'session', patch: { routing: { recipient } } });
      let presented = true;
      let calls = 0;
      const observations: unknown[] = [];
      const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', serverId: scope.serverId,
        accountId: scope.accountId, shouldContinue: () => presented, composerDraft: scopeLifetime,
        onRunAdmitted: observation => observations.push(observation),
        rpc: async () => {
          calls += 1;
          presented = false;
          if (retireAccount) retireActiveServerAccountScopeLifetime();
          return { ...result, runId: 'accepted-run', inputId: 'accepted-input' };
        } });
      const response = await ops.discuss({ ...target, message: 'Explain this result' });
      expect(response, JSON.stringify(response)).toMatchObject({ success: true, runId: 'accepted-run' });
      expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'session' })?.document.target)
        .toMatchObject({ routing: { recipient: { value: retireAccount ? recipient
          : { mode: 'manual', recipient: { kind: 'execution_run', runId: 'accepted-run' } } } } });
      expect(observations).toEqual([]);
      expect(await ops.edit({ cwd: target.cwd, resultId: target.resultId, expectedRevision: target.expectedRevision,
        edit: { kind: 'renameWalkthrough', title: 'Stale edit' } }))
        .toMatchObject({ success: false, errorCode: 'result_unavailable' });
      expect(calls).toBe(1);
    } finally {
      account.dispose();
      resetSessionDraftRepositoryForTests();
    }
  });
  it('shares concurrent exact reads while retaining each reader lifetime and no settled cache', async () => {
    const response = createDeferred<typeof result>();
    let reads = 0;
    let firstCurrent = true;
    const executor = createActionExecutor({ scmActionExecute: async () => { reads += 1; return response.promise; },
      // Only the owning-machine transport boundary is supplied by this fixture.
    } as unknown as ActionExecutorDeps);
    const common = { sessionId: 'session', serverId: 'home', accountId: 'account', actionExecutor: createFrontDoorActionExecute(executor) };
    const first = createScmDiffSummaryResultOperations({ ...common, shouldContinue: () => firstCurrent });
    const second = createScmDiffSummaryResultOperations({ ...common, shouldContinue: () => true });
    const pending = [first.read({ cwd: '/repo', resultId: 'saved' }), second.read({ cwd: '/repo', resultId: 'saved' })];
    firstCurrent = false;
    response.resolve(result);
    expect(await Promise.all(pending)).toEqual([expect.objectContaining({ success: false, errorCode: 'result_unavailable' }), result]);
    expect(reads).toBe(1);
    expect(await second.read({ cwd: '/repo', resultId: 'saved' })).toEqual(result);
    expect(reads).toBe(2);
  });

  it('refuses a disabled saved-result read before any owning-machine transport', async () => {
    const calls: string[] = [];
    const executor = createActionExecutor({ isActionEnabled: () => false,
      scmActionExecute: async () => { calls.push('action-transport'); return result; },
    // Only the owning-machine transport boundary is supplied by this fixture.
    } as unknown as ActionExecutorDeps);
    const ops = createScmDiffSummaryResultOperations({ machineId: 'machine', serverId: 'home', accountId: 'account',
      shouldContinue: () => true, actionExecutor: createFrontDoorActionExecute(executor),
      rpc: async () => { calls.push('direct-transport'); return result; } });
    expect(await ops.read({ cwd: '/repo', resultId: 'saved' })).toMatchObject({ success: false, errorCode: 'action_disabled' });
    expect(calls).toEqual([]);
  });
  it('retains approval admission for saved edits instead of sending a raw mutation', async () => {
    const calls: string[] = [];
    const executor = createActionExecutor({ isActionApprovalRequired: () => true,
      scmActionExecute: async () => { calls.push('action-transport'); return result; },
    // Only the owning-machine transport boundary is supplied by this fixture.
    } as unknown as ActionExecutorDeps);
    const ops = createScmDiffSummaryResultOperations({ machineId: 'machine', shouldContinue: () => true,
      actionExecutor: createFrontDoorActionExecute(executor), rpc: async () => { calls.push('direct-transport'); return result; } });
    expect(await ops.edit({ cwd: '/repo', resultId: 'saved', expectedRevision: 0,
      edit: { kind: 'renameWalkthrough', title: 'Edited' } })).toMatchObject({ success: false, errorCode: 'approvals_not_supported' });
    expect(calls).toEqual([]);
  });
  it('admits workspace effects on the actual Machine without using a Project as a Session', async () => {
    const admitted: unknown[] = [];
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      scmActionExecute: async ({ context }: Parameters<NonNullable<ActionExecutorDeps['scmActionExecute']>>[0]) => {
        admitted.push({ target: context.externalActionTarget, sessionId: context.defaultSessionId });
        return result;
      },
    // The fixture implements the real SCM transport boundary only.
    } as unknown as ActionExecutorDeps);
    const ops = createScmDiffSummaryResultOperations({ machineId: 'machine', serverId: 'home', accountId: 'account',
      shouldContinue: () => true, actionExecutor: createFrontDoorActionExecute(executor) });
    expect(await ops.includeCommitPlanHookChanges({ cwd: '/repo', resultId: 'saved', expectedRevision: 0,
      groupId: 'one', beforeTreeOid: 'a'.repeat(40), afterTreeOid: 'b'.repeat(40) })).toEqual(result);
    expect(admitted).toEqual([{ target: { kind: 'machine', machineId: 'machine' }, sessionId: undefined }]);
  });
  it('admits acceptance through real Action policy and never falls back to direct mutation RPC', async () => {
    const calls: string[] = [];
    // The RPC is the only exercised system boundary; Action admission and schemas are real.
    const executor = createActionExecutor({ isActionApprovalRequired: () => true,
      scmActionExecute: async () => { calls.push('writer'); return result; },
    // This fixture supplies only the exercised RPC boundary; unrelated transports are never invoked.
    } as unknown as ActionExecutorDeps);
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
      actionExecutor: createFrontDoorActionExecute(executor), rpc: async () => { calls.push('unsafe-rpc'); return result; } });
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
      shouldContinue: () => current, actionExecutor: createFrontDoorActionExecute(executor), rpc: async () => { throw new Error('Unsafe mutation RPC'); } });
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
  it('returns a completed effect receipt without publishing an admission into a retired binding', async () => {
    let current = true;
    const observations: unknown[] = [];
    const admitted = ScmDiffSummaryResultResponseSchema.parse({ ...result, runId: 'actual-run', inputId: 'actual-input' });
    const ops = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => current,
      onRunAdmitted: observation => observations.push(observation),
      rpc: async () => { current = false; return admitted; } });
    expect(await ops.edit({ cwd: '/repo', resultId: 'saved', expectedRevision: 0,
      edit: { kind: 'renameWalkthrough', title: 'Acknowledged' } })).toEqual(admitted);
    expect(observations).toEqual([]);
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
  it('says a walkthrough message or edit with an unknown outcome could not be confirmed, never the raw code', async () => {
    // The owning-machine transport reports a dispatched write whose reply was lost (its real envelope).
    const ops = createScmDiffSummaryResultOperations({ machineId: 'machine', shouldContinue: () => true,
      rpc: async () => ({ ok: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN', error: 'COMMAND_OUTCOME_UNKNOWN' }) });
    const sent = await ops.discuss({ cwd: '/repo', resultId: 'saved', expectedRevision: 0, message: 'Why this order?' });
    expect(sent).toMatchObject({ success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN', error: t('errors.scmMessageOutcomeUnknown') });
    const edited = await ops.edit({ cwd: '/repo', resultId: 'saved', expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Edited' } });
    expect(edited).toMatchObject({ success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN', error: t('errors.scmOutcomeUnknown') });
  });
});
