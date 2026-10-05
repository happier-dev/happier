import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, ScmDiffSummaryGenerateOutputSchema, ExecutionRunGetResponseSchema, ProviderBoundModelRefSchema, ReviewCommentsV1Schema, type ActionExecutorDeps, type ScmActionExecute } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { executeScmActionOperation } from './executeScmActionOperation';

const cwd = '/saved/repository';
const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
  metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
  comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
    inventory: { state: 'complete', files: [], reasons: [] } },
  requestedOutputs: ['summary', 'walkthrough'], outputs: {
    summary: { state: 'complete', value: { summaryMarkdown: 'Preserved summary' } },
    walkthrough: { state: 'complete', value: { title: 'Original', intro: 'Intro', stops: [], otherChangeRefs: [] } },
  }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] }, runId: 'saved-generator',
});
const run = {
  runId: 'saved-generator', callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
  status: 'running', startedAtMs: 0, lifecycle: { v: 1, state: 'current' },
  interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
} as const;

function createScmResultActionExecutor(scmActionExecute: NonNullable<ActionExecutorDeps['scmActionExecute']>) {
  // This machine-transport fixture supplies the real SCM route; unrelated transport boundaries are not exercised.
  return createActionExecutor({ scmActionExecute } as unknown as ActionExecutorDeps);
}

describe('saved SCM result Action boundary', () => {
  it('lists only permitted machine results and clears exactly confirmed revisions without erasing a newer edit', async () => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'saved-session', output });
    const excluded = await scmDiffSummaryResultStore.create({ cwd: '/private', output });
    const execute = (actionId: 'scm.diffSummary.result.list' | 'scm.diffSummary.result.clear', input: unknown) => executeScmActionOperation({
      actionId, input, workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
    });
    const listed = await execute('scm.diffSummary.result.list', {});
    expect(listed).toMatchObject({ success: true, results: expect.arrayContaining([expect.objectContaining({
      cwd, sessionId: 'saved-session', resultId: saved.resultId, revision: 0, comparisonId: 'comparison',
    })]) });
    expect(JSON.stringify(listed)).not.toContain(excluded.resultId);
    await scmDiffSummaryResultStore.edit({ cwd, resultId: saved.resultId, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'New manual edit' } });
    expect(await execute('scm.diffSummary.result.clear', { results: [
      { cwd, sessionId: 'saved-session', resultId: saved.resultId, expectedRevision: 0, comparisonId: 'comparison' },
      { cwd: '/private', resultId: excluded.resultId, expectedRevision: 0, comparisonId: 'comparison' },
    ] })).toMatchObject({ success: true, deleted: [], failures: [
      { resultId: saved.resultId, errorCode: 'revision_conflict', latestRevision: 1 },
      { resultId: excluded.resultId, errorCode: 'result_unavailable' },
    ] });
    expect(await execute('scm.diffSummary.result.clear', { results: [{ cwd, sessionId: 'saved-session',
      resultId: saved.resultId, expectedRevision: 1, comparisonId: 'comparison' }] }))
      .toMatchObject({ success: true, deleted: [{ resultId: saved.resultId, comparisonId: 'comparison' }], failures: [] });
    expect(await scmDiffSummaryResultStore.read({ cwd: '/private', resultId: excluded.resultId })).toMatchObject({ success: true });
    const applying = await scmDiffSummaryResultStore.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      requestedOutputs: ['summary', 'walkthrough', 'commitPlan'], outputs: { ...output.outputs,
        commitPlan: { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } } },
    }) });
    expect(await scmDiffSummaryResultStore.beginApplication({ cwd, resultId: applying.resultId, expectedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: cwd, expectedHeadOid: null,
        expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
    })).toMatchObject({ success: true, result: { revision: 1 } });
    expect(await execute('scm.diffSummary.result.clear', { results: [{ cwd, resultId: applying.resultId,
      expectedRevision: 1, comparisonId: 'comparison' }] })).toMatchObject({ success: true, deleted: [],
        failures: [{ resultId: applying.resultId, errorCode: 'application_locked' }] });
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: applying.resultId })).toMatchObject({ success: true });
  });
  it('refuses historical comparison acceptance through the public Action without invoking a Git writer', async () => {
    const historical = ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      metadata: { source: { kind: 'commit', commit: 'a'.repeat(40) }, sourceKey: 'comparison' },
      comparison: { ...output.comparison, source: { kind: 'commit', commit: 'a'.repeat(40) } },
    });
    const saved = await scmDiffSummaryResultStore.create({ cwd, output: historical });
    const executor = createScmResultActionExecutor(({ actionId, input }) => executeScmActionOperation({
      actionId, input, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
    }));
    expect(await executor.execute('scm.diffSummary.commitPlan.accept', {
      cwd, resultId: saved.resultId, expectedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: cwd, expectedHeadOid: 'a'.repeat(40),
        expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
    }, { surface: 'rpc', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { success: false, errorCode: 'source_not_pending' } });
  });
  it.each(['discuss', 'refine', 'explain', 'seedExplain'] as const)('materializes selected current stop evidence and preserves the separate %s output contract', async (operation) => {
    const selected = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, comparison: { ...output.comparison,
      inventory: { state: 'complete', reasons: [], files: [{ path: 'code.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -2 +2 @@\n-old\n+saved code\n' },
        occurrences: [{ id: 'HOST-OCCURRENCE-SELECTED', alias: 'c1', path: 'code.ts', before: { startLine: 2, lineCount: 1 },
          after: { startLine: 2, lineCount: 1 }, position: 0, evidence: { state: 'available' } }] }] } },
      outputs: { ...output.outputs, walkthrough: { state: 'complete', value: { title: 'Manual title', intro: '', otherChangeRefs: [],
        stops: [{ id: 'stop', title: 'Current stop title', explanationMarkdown: 'Current manual reasoning', changeRefs: ['HOST-OCCURRENCE-SELECTED'] }] } } },
      analysis: { suppliedChangeRefs: ['HOST-OCCURRENCE-SELECTED'], analysedChangeRefs: ['HOST-OCCURRENCE-SELECTED'], remainingChangeRefs: [] },
    });
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: selected,
      generator: { backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, modelId: 'selected-model' } });
    let sent: { message: string; localId: string; metaOverrides?: { happier?: { kind: string; payload: unknown } } } | undefined;
    let seededInput: Record<string, unknown> | undefined;
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (id, input) => {
      if (id === 'execution.run.get') return operation === 'seedExplain' ? { ok: false, errorCode: 'execution_run_not_found', error: 'Unavailable' } : { ok: true, result: { run } };
      if (id === 'execution.run.start') {
        seededInput = (input as { intentInput: Record<string, unknown> }).intentInput;
        return { ok: true, result: { runId: 'seeded', callId: 'call', sidechainId: 'side', status: 'running' } };
      }
      if (id !== 'session.message.send') throw new Error('Discussion must target saved generator');
      sent = input as NonNullable<typeof sent>;
      return { ok: true, result: { status: 'accepted', localId: sent.localId } };
    };
    const targets = [{ stopId: 'stop', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }];
    expect(await executeScmActionOperation({ actionId: operation === 'discuss' ? 'scm.diffSummary.discuss' : 'scm.diffSummary.refine', input: {
      cwd, resultId: created.resultId, expectedRevision: 0, stopIds: ['stop'],
      ...(operation === 'discuss' ? { message: 'Explain this stop' } : { output: 'walkthrough', instructions: 'Explain finding',
        ...(operation !== 'refine' ? { reviewExplanation: { targets } } : {}) }),
    }, workingDirectory: cwd, executeCanonicalAction, actionContext: { surface: 'rpc', authority: 'present_user' } }))
      .toMatchObject({ success: true, runId: operation === 'seedExplain' ? 'seeded' : run.runId });
    if (operation === 'seedExplain') {
      expect(seededInput?.instructions).not.toContain('HOST-OCCURRENCE-SELECTED');
      expect(seededInput?.instructions).toContain('"changeRefs":["c1"]');
      expect(seededInput?.reviewExplanation).toBeUndefined();
      expect(seededInput?.reviewExplanationInputId).toEqual(expect.any(String));
      const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: created.resultId,
        inputIds: [String(seededInput?.reviewExplanationInputId)] });
      expect(pending?.reviewExplanation).toMatchObject({ targets, requestedBy: { kind: 'user' } });
      return;
    }
    expect(sent?.message).toContain('Current manual reasoning');
    expect(sent?.message).toContain('+saved code');
    expect(sent?.message).not.toContain('HOST-OCCURRENCE-SELECTED');
    expect(sent?.message).toContain('"changeRefs":["c1"]');
    if (operation === 'explain') {
      expect(sent?.message).toContain('"reviewExplanations"');
      const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: created.resultId, inputIds: [sent!.localId] });
      expect(pending?.reviewExplanation).toMatchObject({ targets, requestedBy: { kind: 'user' }, requestedAtMs: expect.any(Number) });
      expect(await scmDiffSummaryResultStore.publish({ cwd, resultId: created.resultId, inputId: sent!.localId,
        modelOutput: { reviewExplanations: [{ stopId: 'stop', markdown: 'Separate explanation' }] } }))
        .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [{
          explanationMarkdown: 'Current manual reasoning', reviewExplanations: [{ markdown: 'Separate explanation' }],
        }] } } } } } });
    } else if (operation === 'discuss') {
      expect(sent?.metaOverrides?.happier?.kind).toBe('review_comments.v1');
      expect(ReviewCommentsV1Schema.parse(sent?.metaOverrides?.happier?.payload)).toMatchObject({ sessionId: 'session', comments: [{
      filePath: 'code.ts', body: expect.stringContaining('Current manual reasoning'),
      anchor: { kind: 'diffLine', side: 'after', newLine: 2 }, snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
      }] });
    }
  });
  it.each([false, true])('starts one labelled seeded generator preserving saved provider selection (original available=%s)', async (originalAvailable) => {
    const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:codex', providerConnectionId: 'chosen-provider', modelId: 'chosen-model' });
    const generator = { backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const }, modelId: 'chosen-model', modelSelection };
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output, generator });
    const starts: unknown[] = [];
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.discuss',
      input: { cwd, resultId: created.resultId, expectedRevision: 0, message: 'Why this change?', startNew: true }, workingDirectory: cwd,
      executeCanonicalAction: async (id, input) => {
        if (id === 'execution.run.get') return originalAvailable ? { ok: true, result: { run } } : { ok: false, errorCode: 'execution_run_not_found', error: 'Gone' };
        if (id !== 'execution.run.start') throw new Error('Fallback must admit one canonical generator');
        starts.push(input);
        await scmDiffSummaryResultStore.bindRun({ cwd, resultId: created.resultId, expectedRevision: 0, runId: 'replacement', seededFromRunId: 'saved-generator' });
        return { ok: true, result: { runId: 'replacement', callId: 'call', sidechainId: 'sidechain' } };
      },
    });
    expect(response).toMatchObject({ success: true, runId: 'replacement', seededFromRunId: 'saved-generator', result: { revision: 1 } });
    expect(starts).toEqual([expect.objectContaining({ kind: 'scm_diff_summary.v1', backendTarget: generator.backendTarget, modelId: 'chosen-model', modelSelection,
      intentInput: expect.objectContaining({ resultId: created.resultId, comparisonId: 'comparison', expectedRevision: 0 }) })]);
  });
  it('reads and edits a retained result without a live generator and preserves strict revision failures', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] } };
    const executor = createScmResultActionExecutor(({ actionId, input, executeCanonicalAction }) =>
      executeScmActionOperation({ ...base, actionId, input, executeCanonicalAction }));
    expect(await executor.execute('scm.diffSummary.result.read', { cwd, resultId: created.resultId }, { surface: 'rpc', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { success: true, result: { revision: 0 } } });
    const input = { cwd, resultId: created.resultId, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } };
    expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.edit', input }))
      .toMatchObject({ success: true, result: { revision: 1, output: { outputs: { summary: output.outputs?.summary } } } });
    const stale = await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.edit', input, rpcCompatibility: true });
    expect(stale).toEqual({ success: false, errorCode: 'revision_conflict', error: expect.any(String), latestRevision: 1 });
    expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.read', input: { cwd: '/outside', resultId: created.resultId } }))
      .toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });

  it('binds revision before sending a targeted retained input to the generator participant', async () => {
    ExecutionRunGetResponseSchema.parse({ run });
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const executeCanonicalAction = vi.fn<Parameters<ScmActionExecute>[0]['executeCanonicalAction']>(async (id, input) => {
      if (id === 'execution.run.get') return { ok: true, result: { run } };
      if (id !== 'session.message.send') throw new Error('Detached or replacement dispatch is incorrect');
      const message = input as { localId: string };
      await scmDiffSummaryResultStore.edit({ cwd, resultId: created.resultId, expectedRevision: 0,
        edit: { kind: 'renameWalkthrough', title: 'Other device title' } });
      expect(await scmDiffSummaryResultStore.publish({ cwd, resultId: created.resultId, inputId: message.localId,
        modelOutput: { walkthrough: { title: 'Stale', intro: '', stops: [], otherChangeRefs: [] } } }))
        .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
      return { ok: true, result: { status: 'accepted', localId: message.localId } };
    });
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.refine',
      input: { cwd, resultId: created.resultId, expectedRevision: 0, output: 'walkthrough', instructions: 'Clarify the rationale' },
      workingDirectory: cwd, executeCanonicalAction });
    expect(response).toEqual(expect.objectContaining({ success: true, runId: run.runId, inputId: expect.any(String) }));
    expect(executeCanonicalAction).toHaveBeenCalledWith('session.message.send', expect.objectContaining({
      sessionId: 'session', recipient: { kind: 'execution_run', runId: run.runId }, localId: expect.any(String),
    }));
  });
});
