import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionRunScmDiffSummaryInputV1Schema, ProviderBoundModelRefSchema, SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, ScmComparisonSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol';
import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { ScmDiffSummaryProfile } from './ScmDiffSummaryProfile';
import { scmDiffSummaryCacheStore } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { advanceDiffSummaryAnalysis } from './advanceDiffSummaryAnalysis';
import { prepareSavedReviewWalkthroughInput } from '@/agent/executionRuns/profiles/review/reviewWalkthroughTurn';

const comparison = ScmComparisonSchema.parse({
  id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
  inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
    binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
    occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', before: { startLine: 1, lineCount: 1 },
      after: { startLine: 1, lineCount: 1 }, position: 0 }],
  }] },
});
function start(intentInput: unknown, effectiveModelId?: string): ExecutionRunProfileStartParams {
  return { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1',
    intent: 'scm_diff_summary', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    instructions: 'prompt', intentInput, permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
    ...(effectiveModelId ? { effectiveEngine: { agentId: 'claude', modelId: effectiveModelId } } : {}) };
}
function input(outputs: string[] = ['summary']) {
  return { source: comparison.source, sourceKey: comparison.id, comparison, outputs,
    metadata: { source: comparison.source, sourceKey: comparison.id } };
}
async function admitInitial(params: ExecutionRunProfileStartParams) {
  const initial = await ScmDiffSummaryProfile.onStarted?.({ start: params, rawText: '', finishedAtMs: params.startedAtMs });
  const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
  return { start: { ...params, intentInput: { ...(params.intentInput as Record<string, unknown>), resultId: saved.resultId } },
    previousStructuredMeta: initial?.structuredMeta };
}

describe('ScmDiffSummaryProfile', () => {
  beforeEach(() => { scmDiffSummaryCacheStore.clear(); });

  it.each([false, true])('plans a known-capacity single hunk before admission with exact fragments and same-run part progress (single line: %s)', async (singleLine) => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-scm-capacity-'));
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    writeFileSync(join(directory, 'large.txt'), 'old\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: directory });
    writeFileSync(join(directory, 'large.txt'), singleLine ? 'line-😀'.repeat(500) + '\n'
      : Array.from({ length: 200 }, (_, i) => `line-${i} 😀`).join('\n') + '\n');
    const captured = await captureScmComparison({ cwd: directory, sessionId: 'sess-1', source: { kind: 'workingTree' } });
    const prepare = await ScmDiffSummaryProfile.prepareStartParams!({ cwd: directory, sessionId: 'sess-1',
      contextWindowTokens: 2200, request: { backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'scm_diff_summary',
        instructions: 'Explain carefully', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd: directory, comparisonId: captured.comparison.id, source: { kind: 'workingTree' }, outputs: ['summary'] } } });
    const preparedInput = prepare!.intentInput as Record<string, unknown>;
    expect(preparedInput.scmAnalysis).toMatchObject({ phase: 'evidence', currentFragment: {
      path: 'large.txt', startOffset: expect.any(Number), endOffset: expect.any(Number),
    } });
    expect(new TextEncoder().encode(String(prepare!.instructions)).byteLength).toBeLessThanOrEqual(2200);
    const active = preparedInput.scmAnalysis as { currentDiff: string; currentFragment: { startOffset: number; endOffset: number };
      pending: { diff: string; fragment: { startOffset: number; endOffset: number } }[] };
    expect(active.pending.length).toBeGreaterThan(0);
    const source = captured.comparison.inventory.files[0]!.evidence.unifiedDiff!;
    const fragments = [{ diff: active.currentDiff, fragment: active.currentFragment }, ...active.pending];
    let offset = source.indexOf('@@ ');
    for (const part of fragments) {
      expect(part.fragment.startOffset).toBe(offset);
      expect(part.diff).toBe(source.slice(part.fragment.startOffset, part.fragment.endOffset));
      expect(part.diff).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
      offset = part.fragment.endOffset;
    }
    expect(offset).toBe(source.length);
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: start(preparedInput) })).toBe('');
    const completion = advanceDiffSummaryAnalysis({ start: start(preparedInput), turnId: 'known-part', finishedAtMs: 2,
      rawText: JSON.stringify({ summaryMarkdown: 'Part' }) });
    expect(completion?.toolResultOutput).toMatchObject({ analysis: { parts: { admitted: 1, completed: 1,
      total: active.pending.length + 1, phase: 'evidence' } } });
    expect(completion?.nextInput?.instructions).toContain('Fragment offsets');
    expect(completion?.nextInput?.instructions).toContain('Context before');
    let next = completion?.nextInput;
    let turn = 0;
    while (next && (next.intentInput as { scmAnalysis: { phase: string } }).scmAnalysis.phase === 'evidence') {
      expect(new TextEncoder().encode(next.instructions).byteLength).toBeLessThanOrEqual(2200);
      const advanced = advanceDiffSummaryAnalysis({ start: start(next.intentInput), turnId: `checked-${turn++}`,
        inputIds: [next.localId], finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Part' }) });
      next = advanced?.nextInput;
    }
  });

  it('retains the original request through unknown-capacity native rejection and final integration', () => {
    const instruction = 'Keep the requested behavioral explanation, not only a file list.';
    const rejected = advanceDiffSummaryAnalysis({ start: start({ ...input(), instructions: instruction }),
      turnId: 'rejected', finishedAtMs: 2, rawText: '', diagnostic: { code: 'agent_context_window_exceeded' } });
    expect(rejected?.nextInput?.instructions).toContain(instruction);
    let next = rejected?.nextInput;
    let index = 0;
    while (next && (next.intentInput as { scmAnalysis: { phase: string } }).scmAnalysis.phase === 'evidence') {
      next = advanceDiffSummaryAnalysis({ start: start(next.intentInput), inputIds: [next.localId],
        turnId: `fallback-${index++}`, finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Part' }) })?.nextInput;
    }
    expect(next?.instructions).toContain(instruction);
  });

  it('persists confirmed part admissions once without losing the admitted publication basis', async () => {
    const active = { ...input(), scmAnalysis: { phase: 'evidence', current: ['change-1'],
      pending: [{ refs: ['change-1'] }], parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const admitted = await admitInitial(start(active));
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...admitted, turnId: 'first-part', finishedAtMs: 2,
      rawText: JSON.stringify({ summaryMarkdown: 'First part' }) });
    expect(first?.toolResultOutput).toMatchObject({ analysis: { parts: { admitted: 1, completed: 1, total: 2 } } });
    const nextStart = start(first!.nextInput!.intentInput);
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: nextStart, localId: first!.nextInput!.localId });
    const receipt = await ScmDiffSummaryProfile.onRetainedInputAdmitted?.({ start: nextStart, localId: first!.nextInput!.localId });
    expect(receipt?.toolResultOutput).toMatchObject({ analysis: { parts: { admitted: 2, completed: 1, total: 2 } } });
    const current = { ...nextStart, intentInput: receipt!.updatedIntentInput };
    expect(await ScmDiffSummaryProfile.onRetainedInputAdmitted?.({ start: current, localId: first!.nextInput!.localId })).toBeNull();
    const second = await ScmDiffSummaryProfile.onTurnComplete?.({ start: current, turnId: 'second-part',
      inputIds: [first!.nextInput!.localId], finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Second part' }) });
    expect(second?.toolResultOutput).toMatchObject({ analysis: { parts: { admitted: 2, completed: 2, total: 2, phase: 'merge' } } });
  });

  it('presents aliases in retained multipart integration and resolves the final aliases to host references', () => {
    const twoParts = { ...comparison, inventory: { ...comparison.inventory, files: [comparison.inventory.files[0]!,
      { ...comparison.inventory.files[0]!, path: 'b.ts', occurrences: [{ ...comparison.inventory.files[0]!.occurrences[0]!,
        id: 'change-2', alias: 'c2', path: 'b.ts' }] }] } };
    const active = { ...input(['walkthrough']), comparison: twoParts,
      scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [{ refs: ['change-2'] }],
      parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const first = advanceDiffSummaryAnalysis({ start: start(active), turnId: 'part', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(first?.nextInput?.instructions).toContain('c2');
    expect(first?.nextInput?.instructions).not.toContain('change-2');
    const second = advanceDiffSummaryAnalysis({ start: start(first!.nextInput!.intentInput), turnId: 'part-2',
      inputIds: [first!.nextInput!.localId], finishedAtMs: 3,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c2'] } }) });
    expect(second?.nextInput?.instructions).toContain('"otherChangeRefs":["c1","c2"]');
    expect(second?.nextInput?.instructions).not.toMatch(/change-[12]/);
    const final = advanceDiffSummaryAnalysis({ start: start(second!.nextInput!.intentInput), turnId: 'merge',
      inputIds: [second!.nextInput!.localId], finishedAtMs: 4,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1', 'c2'] } }) });
    expect(final?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'complete', value: { otherChangeRefs: ['change-1', 'change-2'] } } } });
  });

  it('presents aliases in saved discussion context while keeping the saved envelope canonical', () => {
    const payload = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id, comparison,
      metadata: input().metadata, requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Read', intro: '', stops: [], otherChangeRefs: ['change-1'],
      } } }, analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] } });
    const context = ScmDiffSummaryProfile.buildInitialInputContext?.({ start: start({ ...input(), resultId: 'saved' }),
      structuredMeta: { kind: 'scm_diff_summary.v1', payload } });
    expect(context).toContain('"otherChangeRefs":["c1"]');
    expect(context).not.toContain('change-1');
    expect(payload.outputs?.walkthrough?.value?.otherChangeRefs).toEqual(['change-1']);
    expect(parseDiffSummaryModelOutput(JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [],
      otherChangeRefs: ['change-1'] } }), { comparison })).toBeNull();
  });

  it('presents published findings using aliases without exposing finding identities', () => {
    const params = start({ ...input(['walkthrough']), resultId: 'saved', reviewNarration: { phase: 'writing', provenance: {
      reviewedRuns: [{ runId: 'review-a', callId: 'call-a', backendId: 'claude', status: 'failed', hasOutput: true,
        reviewOutcome: 'partial', comparisonId: comparison.id }], narrationMode: 'continued_review', comparisonFreshness: 'unchanged',
    }, reviewFindings: [{ runRef: { runId: 'review-a', callId: 'call-a', backendId: 'claude' },
      findings: [{ id: 'secret-finding-identity', title: 'Published concern', summary: 'Evidence' }] }] } });
    const context = ScmDiffSummaryProfile.buildInitialInputContext?.({ start: params });
    expect(context).toContain('F1');
    expect(context).toContain('Published concern');
    expect(context).toContain('partial');
    expect(context).not.toContain('secret-finding-identity');
    expect(context).toContain('[text](finding:F3)');
  });

  it('retains seeded multi-run finding aliases through native publication and a later explanation input', async () => {
    const provenance = { reviewedRuns: ['review-a', 'review-b'].map(runId => ({ runId, callId: `call-${runId}`,
      backendId: 'claude', status: 'succeeded' as const, hasOutput: true, comparisonId: comparison.id })),
      narrationMode: 'seeded_narrator' as const, comparisonFreshness: 'unchanged' as const };
    const prepared = await prepareSavedReviewWalkthroughInput(start(input(['walkthrough'])), provenance, JSON.stringify({ reviews:
      provenance.reviewedRuns.map(runRef => ({ runRef, findings: [{ id: 'same-real-id', title: runRef.runId, summary: 'Published' }] })) }));
    expect(prepared.instructions).toContain('"id":"F1"');
    expect(prepared.instructions).toContain('"id":"F2"');
    expect(prepared.instructions).not.toContain('same-real-id');
    const params = start(prepared.intentInput, 'native-model');
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'narrate',
      inputIds: [prepared.localId], finishedAtMs: 11, rawText: JSON.stringify({ walkthrough: {
        title: 'Read', intro: '', stops: [{ id: 'stop', title: 'a.ts', changeRefs: ['c1'], findingRefs: ['F2'],
          explanationMarkdown: '[second](finding:F2) [other](finding:F1)' }], otherChangeRefs: [],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(saved.outputs?.walkthrough?.value?.stops[0]).toMatchObject({ findingRefs: ['review-b:same-real-id'],
      explanationMarkdown: '[second](finding:review-b:same-real-id) other' });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'explain-citation', expectedRevision: saved.revision,
      outputs: ['walkthrough'], stopIds: ['stop'], reviewExplanation: { requestedBy: { kind: 'user' }, targets: [
        { stopId: 'stop', findingRefs: [{ runId: 'review-b', findingId: 'same-real-id' }] },
      ] } });
    const explanation = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'explain',
      inputIds: ['explain-citation'], finishedAtMs: 12, previousStructuredMeta: completed?.structuredMeta,
      rawText: JSON.stringify({ reviewExplanations: [{ stopId: 'stop', markdown: '[why](finding:F2) [wrong](finding:F1)' }] }) });
    expect(explanation?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [
      { reviewExplanations: [{ markdown: '[why](finding:review-b:same-real-id) wrong' }] },
    ] } } } });
  });

  it('does not trust model-written canonical finding URLs in the bounded output path', () => {
    const completed = ScmDiffSummaryProfile.onBoundedComplete?.({ start: start(input(['walkthrough'])), finishedAtMs: 3,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', otherChangeRefs: [], stops: [
        { id: 'stop', title: 'a.ts', changeRefs: ['c1'], findingRefs: ['unpublished:actual'],
          explanationMarkdown: '[spoof](finding:unpublished:actual)' },
      ] } }) });
    expect(completed?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [
      { findingRefs: [], explanationMarkdown: 'spoof' },
    ] } } } });
  });

  it('publishes separate finding explanations with the admitted requester and actual native producer', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state: 'complete', value: { title: 'Read', intro: '', otherChangeRefs: [],
        stops: [{ id: 'stop', title: 'a.ts', explanationMarkdown: 'Manual prose', changeRefs: ['change-1'] }] } } },
      analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] },
    }) });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId };
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'explain', outputs: ['walkthrough'], stopIds: ['stop'],
      reviewExplanation: { targets: [{ stopId: 'stop', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }],
        requestedBy: { kind: 'user' }, requestedAtMs: 7 } });
    const seeded = start({ ...input(['walkthrough']), ...scope, resultBaseRevision: 0, stopIds: ['stop'],
      reviewExplanationInputId: 'explain' }, 'native-model');
    await ScmDiffSummaryProfile.onStarted?.({ start: seeded, rawText: '', finishedAtMs: 9 });
    expect(await scmDiffSummaryResultStore.readInput({ ...scope, inputIds: ['initial:run-1'] }))
      .toMatchObject({ reviewExplanation: { requestedBy: { kind: 'user' }, requestedAtMs: 7 } });
    expect(await scmDiffSummaryResultStore.readInput({ ...scope, inputIds: ['explain'] })).toBeNull();
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ start: seeded,
      turnId: 'native-turn', inputIds: ['initial:run-1'], finishedAtMs: 11,
      previousStructuredMeta: { kind: 'scm_diff_summary.v1', payload: created.output },
      rawText: JSON.stringify({ reviewExplanations: [{ stopId: 'stop', markdown: 'Finding clarification' }] }) });
    expect(completed?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [{
      explanationMarkdown: 'Manual prose', reviewExplanations: [{ markdown: 'Finding clarification', provenance: {
        requestedBy: { kind: 'user' }, requestedAtMs: 7, generatedAtMs: 11, runId: 'run-1', modelId: 'native-model',
      } }],
    }] } } } });
  });

  it('persists engine launch failures separately from actual reviewer Run identities', async () => {
    const failures = [{ engineId: 'unavailable-reviewer', errorCode: 'admission_failed', error: 'Engine unavailable' }];
    const params = start({ ...input(['walkthrough']), reviewNarration: { phase: 'writing', provenance: {
      reviewedRuns: [{ runId: 'review', callId: 'review-call', backendId: 'claude', status: 'succeeded', hasOutput: true,
        reviewOutcome: 'complete', comparisonId: comparison.id }], narrationMode: 'seeded_narrator',
      comparisonFreshness: 'unchanged', launchFailures: failures,
    } } });
    const completion = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(params), turnId: 'narrate', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(completion?.toolResultOutput).toMatchObject({ producer: { kind: 'review', launchFailures: failures } });
    const output = ScmDiffSummaryGenerateOutputSchema.parse(completion?.toolResultOutput);
    expect(await scmDiffSummaryResultStore.read({ cwd: '/repo', sessionId: 'sess-1', resultId: output.resultId! }))
      .toMatchObject({ success: true, result: { output: { producer: { launchFailures: failures } } } });
  });

  it('keeps retained partial prose writing until the final multipart merge settles', async () => {
    const active = { ...input(['walkthrough']), scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [],
      parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(active)), turnId: 'part', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(first?.nextInput).toBeDefined();
    expect(first?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'writing', value: { title: 'Read' } } } });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: start(first!.nextInput!.intentInput), localId: first!.nextInput!.localId });
    const final = await ScmDiffSummaryProfile.onTurnComplete?.({ start: start(first!.nextInput!.intentInput), turnId: 'merge',
      inputIds: [first!.nextInput!.localId], previousStructuredMeta: first!.structuredMeta, finishedAtMs: 3, rawText: 'not JSON' });
    expect(final?.nextInput).toBeUndefined();
    expect(final?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'partial' } } });
  });

  it('does not let a replaced generator capture new writes or terminalize the replacement result', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata, runId: 'replacement-run',
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'] },
    }) });
    const previous = start({ ...input(), cwd: '/repo', resultId: created.resultId });
    await expect(ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: previous, localId: 'old-run-input' })).rejects.toThrow();
    expect(await ScmDiffSummaryProfile.onTerminal?.({ start: previous, status: 'cancelled', finishedAtMs: 2 })).toBeNull();
    expect(await scmDiffSummaryResultStore.read({ cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId }))
      .toMatchObject({ success: true, result: { revision: 0, output: { runId: 'replacement-run', outputs: { summary: { state: 'pending' } } } } });
  });

  it('does not publish unmatched completion or resurrect a replaced generator even without input IDs', async () => {
    const initial = await ScmDiffSummaryProfile.onStarted?.({ start: start(input(['walkthrough'])), rawText: '', finishedAtMs: 2 });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const incumbent = start({ ...input(['walkthrough']), ...scope });
    const replacement = await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: saved.revision!, runId: 'replacement' });
    if (!replacement.success) throw new Error(replacement.error);
    const manual = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: replacement.result.revision,
      edit: { kind: 'replaceWalkthrough', value: { title: 'Manual title', intro: '', stops: [], otherChangeRefs: ['change-1'] } } });
    if (!manual.success) throw new Error(manual.error);
    for (const inputIds of [undefined, ['unmatched'], ['initial:run-1']]) {
      expect(await ScmDiffSummaryProfile.onTurnComplete?.({ start: incumbent, turnId: 'late', inputIds, finishedAtMs: 4,
        previousStructuredMeta: initial?.structuredMeta, rawText: JSON.stringify({ walkthrough: {
          title: 'Old overwrite', intro: '', stops: [], otherChangeRefs: ['c1'],
        } }) })).toBeNull();
    }
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: {
      revision: manual.result.revision, output: { runId: 'replacement', outputs: { walkthrough: { value: { title: 'Manual title' } } } },
    } });
  });

  it('uses only admitted initial or follow-up revision bases on completion', async () => {
    const requested = { ...input(['walkthrough']), requestedModelId: 'narrator-model', resolvedSelector: { catalogId: 'profile:narrator-model' } };
    const initial = await ScmDiffSummaryProfile.onStarted?.({ start: start(requested, 'narrator-model'), rawText: '', finishedAtMs: 2 });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const params = start({ ...requested, ...scope }, 'narrator-model');
    const rawText = JSON.stringify({ walkthrough: { title: 'First', intro: '', stops: [], otherChangeRefs: ['c1'] } });
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'first-native', finishedAtMs: 3,
      previousStructuredMeta: initial?.structuredMeta, rawText });
    expect(first?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { title: 'First' } } } });
    expect(await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'unadmitted-native', finishedAtMs: 4,
      previousStructuredMeta: first?.structuredMeta, rawText })).toBeNull();
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: params, localId: 'follow-up' });
    const current = ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput);
    await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: current.revision!, edit: { kind: 'renameWalkthrough', title: 'New manual edit' } });
    const conflict = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'follow-native', inputIds: ['follow-up'],
      finishedAtMs: 5, previousStructuredMeta: first?.structuredMeta,
      rawText: JSON.stringify({ walkthrough: { title: 'Rejected stale model result', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(conflict?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'revision_conflict' } });
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: { output: {
      outputs: { walkthrough: { value: { title: 'New manual edit' } } },
    } } });
    expect(scmDiffSummaryCacheStore.get({ source: { kind: 'comparison', comparisonId: comparison.id },
      summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, resolvedSelector: requested.resolvedSelector,
      outputs: ['walkthrough'], scopeKey: 'sess-1' })).toMatchObject({ outputs: { walkthrough: { value: { title: 'First' } } } });
  });

  it('keeps the admitted initial revision rather than rebasing model kickoff over an intervening manual edit', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata,
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'] },
    }) });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId };
    await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: 0,
      edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'My newer manual explanation.' } } });
    await expect(ScmDiffSummaryProfile.onStarted?.({ start: start({ ...input(), ...scope, resultBaseRevision: 0 }), rawText: '', finishedAtMs: 2 }))
      .rejects.toThrow();
    await ScmDiffSummaryProfile.onTerminal?.({ start: start({ ...input(), ...scope, resultBaseRevision: 0 }), status: 'failed', finishedAtMs: 3 });
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
      result: { revision: 1, canUndo: true, output: { summaryMarkdown: 'My newer manual explanation.', outputs: { summary: { state: 'complete' } } } } });
  });

  it('repairs only requested structured output variants using the captured reference contract', () => {
    const params = start(input(['walkthrough', 'commitPlan']));
    const repair = ScmDiffSummaryProfile.buildInvalidOutputRepairPrompt?.({ start: params, rawText: 'Invalid result' }) ?? '';
    expect(repair.includes('"walkthrough":')).toBe(true);
    expect(repair.includes('"commitPlan":')).toBe(true);
    expect(repair.includes('"summaryMarkdown":')).toBe(false);
    expect(repair.includes('c1')).toBe(true);
    expect(parseDiffSummaryModelOutput(JSON.stringify({ walkthrough: { title: 'a', intro: '', stops: [], otherChangeRefs: ['c1'] },
      commitPlan: { groups: [], leftOutChangeRefs: ['c1'] } }), { comparison, requestedOutputs: ['walkthrough', 'commitPlan'], requireCompleteCoverage: true }))
      .toMatchObject({ walkthrough: { otherChangeRefs: ['change-1'] }, commitPlan: { leftOutChangeRefs: ['change-1'] } });
  });

  it('does not claim evidence was supplied when terminal cancellation has no prior generation artifact', async () => {
    const settled = await ScmDiffSummaryProfile.onTerminal?.({ start: start(input()), status: 'cancelled', finishedAtMs: 2 });
    expect(settled?.toolResultOutput).toMatchObject({ outputs: { summary: { state: 'cancelled' } }, analysis: {
      suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'],
    } });
  });

  it('seeds cached follow-up context from the current capture while retaining the original generation provenance', async () => {
    const cachedOutput = { success: true, sourceKey: comparison.id, comparison, metadata: input().metadata,
      runId: 'original-run', producer: { kind: 'generation', runId: 'original-run' },
      cost: { inputTokens: 17 }, summaryMarkdown: 'Saved explanation.',
      requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation.' } } },
      analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] } };
    const current = start({ ...input(), cachedOutput });
    const restored = await ScmDiffSummaryProfile.onStarted?.({ start: current, rawText: '', finishedAtMs: 2 });
    expect(restored?.toolResultOutput).toMatchObject({ runId: 'run-1', producer: { runId: 'original-run', seededFromRunId: 'original-run' },
      cost: { inputTokens: 17 }, comparison, metadata: input().metadata });
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: current, structuredMeta: restored?.structuredMeta })).toContain('Saved explanation.');
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: current, structuredMeta: restored?.structuredMeta })).toContain('+new');
  });

  it('supplies every captured file and the full textual evidence to model admission', () => {
    const marker = 'LAST-LINE-BEYOND-THE-FORMER-SLICE';
    const files = Array.from({ length: 101 }, (_, index) => ({ path: `src/file-${index}.ts`,
      changeKind: 'modified', unifiedDiff: `${'a'.repeat(16_001)}\n${marker}-${index}` }));
    const prompt = buildDiffSummaryPrompt({ metadata: { source: { kind: 'workingTree' }, sourceKey: 'pending' }, files });
    expect(prompt.includes('src/file-100.ts')).toBe(true);
    expect(prompt.includes(`${marker}-100`)).toBe(true);
    expect(prompt.includes(`${marker}-0`)).toBe(true);
  });

  it('uses the strict protocol output contract without arbitrary prose length limits', () => {
    expect(parseDiffSummaryModelOutput(JSON.stringify({ summaryMarkdown: 'a'.repeat(80_001) }))?.summaryMarkdown?.length).toBe(80_001);
    expect(parseDiffSummaryModelOutput(JSON.stringify({ summaryMarkdown: 'Valid.', injectedCommand: 'git commit' }))).toBeNull();
  });

  it('publishes walkthrough-only output with captured identities and separate analysis coverage', async () => {
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(input(['walkthrough']))),
      turnId: 'turn-1', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Read the change', intro: '', stops: [{ id: 'stop-1', title: 'a.ts', explanationMarkdown: 'Updates a.', changeRefs: ['c1'] }],
        otherChangeRefs: [],
      } }) });
    const output = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(output).not.toHaveProperty('summaryMarkdown');
    expect(output.outputs?.walkthrough).toMatchObject({ state: 'complete', value: { stops: [{ changeRefs: ['change-1'] }] } });
    expect(output.outputs).not.toHaveProperty('summary');
    expect(output.analysis).toEqual({ suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] });
  });

  it('publishes a readable saved result identity and revision on retained structured completion', async () => {
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(input(['walkthrough']))),
      turnId: 'saved-turn', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Saved beyond the generator', intro: '', stops: [], otherChangeRefs: ['c1'],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(saved.resultId).toEqual(expect.any(String));
    expect(saved.revision).toBe(2);
  });

  it('preserves prior output when later structured turns complete another requested output and ignores invalid discussion', async () => {
    const requested = { ...input(['summary']), requestedModelId: 'summary-model', resolvedSelector: { catalogId: 'profile:summary-model' } };
    const params = { ...await admitInitial(start(requested, 'summary-model')), turnId: 'turn-1', finishedAtMs: 2 };
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, rawText: '{"summaryMarkdown":"Useful summary"}' });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput);
    const followupStart = start({ ...requested, resultId: saved.resultId }, 'summary-model');
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const added = await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'second', outputs: ['commitPlan'] });
    if (!added.success) throw new Error(added.error);
    const second = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, turnId: 'turn-2',
      inputIds: ['second'],
      previousStructuredMeta: first?.structuredMeta, rawText: JSON.stringify({ commitPlan: {
        groups: [{ id: 'group-1', message: 'fix: update a', rationale: '', changeRefs: ['c1'] }], leftOutChangeRefs: [],
      } }) });
    expect(second?.toolResultOutput).toMatchObject({ summaryMarkdown: 'Useful summary', outputs: {
      summary: { state: 'complete', value: { summaryMarkdown: 'Useful summary' } }, commitPlan: { state: 'complete' },
    } });
    const cacheKey = { source: { kind: 'comparison' as const, comparisonId: comparison.id },
      summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, resolvedSelector: requested.resolvedSelector, scopeKey: 'sess-1' };
    expect(scmDiffSummaryCacheStore.get({ ...cacheKey, outputs: ['summary'] })).toMatchObject({ requestedOutputs: ['summary'] });
    expect(scmDiffSummaryCacheStore.get({ ...cacheKey, outputs: ['summary', 'commitPlan'] })).toMatchObject({
      requestedOutputs: ['summary', 'commitPlan'], outputs: { commitPlan: { state: 'complete' } },
    });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'chat' });
    expect(await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, inputIds: ['chat'], previousStructuredMeta: second?.structuredMeta,
      rawText: 'An ordinary discussion answer.' })).toBeNull();
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'invalid' });
    const invalid = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, inputIds: ['invalid'], previousStructuredMeta: second?.structuredMeta,
      rawText: JSON.stringify({ commitPlan: { groups: [], leftOutChangeRefs: ['invented'] } }) });
    expect(invalid?.toolResultOutput).toEqual(second?.toolResultOutput);
    expect(invalid?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'invalid_output' } });
  });

  it('does not claim unavailable occurrences in partially readable evidence were analysed', async () => {
    const partial = { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete' as const,
      reasons: ['One layer unavailable'], files: comparison.inventory.files.map((file) => ({ ...file,
        evidence: { state: 'unavailable' as const, reason: 'One layer unavailable', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
        occurrences: [{ ...file.occurrences[0]!, evidence: { state: 'available' as const } },
          { ...file.occurrences[0]!, id: 'change-2', alias: 'c2', evidence: { state: 'unavailable' as const, reason: 'Missing layer' } }],
      })) } };
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start({ ...input(), comparison: partial })),
      turnId: 'turn-1', finishedAtMs: 2, rawText: '{"summaryMarkdown":"Evidence partly unavailable."}' });
    expect(completed?.toolResultOutput).toMatchObject({ analysis: {
      suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: ['change-2'],
    } });
    const malformed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start({ ...input(), comparison: partial })),
      turnId: 'turn-invalid', finishedAtMs: 3, rawText: 'Malformed first generation.' });
    expect(malformed?.toolResultOutput).toMatchObject({ analysis: {
      suppliedChangeRefs: ['change-1'], analysedChangeRefs: [], remainingChangeRefs: ['change-1', 'change-2'],
    } });
  });

  it('reuses only the requested-output cache for a canonical capture and honours bypass', async () => {
    // Git/disk are genuine boundaries; capture/admission/cache/profile run real logic.
    const cwd = mkdtempSync(join(tmpdir(), 'happier-summary-profile-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'a.ts'), 'new\n');
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'sess-1' });
    const request = { kind: 'scm_diff_summary.v1' as const, intent: 'scm_diff_summary' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
      modelId: 'fast-summary',
      modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'connection-a', modelId: 'fast-summary' }),
      permissionMode: 'read_only', retentionPolicy: 'resumable' as const, runClass: 'long_lived' as const, ioMode: 'streaming' as const,
      intentInput: { cwd, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
        outputs: ['summary'], resolvedSelector: { catalogId: 'profile:fast-summary' } } };
    const pending = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)) },
    }) });
    const captureFirst = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: { ...request,
      intentInput: { ...request.intentInput, resultId: pending.resultId, expectedRevision: 0, cachePolicy: { mode: 'bypass' } } } });
    expect(captureFirst?.instructions).toContain('"summaryMarkdown":');
    expect(ExecutionRunScmDiffSummaryInputV1Schema.safeParse(captureFirst?.intentInput).success).toBe(true);
    expect(captureFirst?.instructions).not.toContain('replacement generator');
    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request });
    ScmDiffSummaryProfile.onBoundedComplete({ start: start(prepared?.intentInput, 'fast-summary'), finishedAtMs: 2,
      rawText: '{"summaryMarkdown":"Cached explanation."}' });
    const cached = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request });
    expect(cached?.intentInput).toMatchObject({ cachedOutput: { success: true, summaryMarkdown: 'Cached explanation.' } });
    expect(cached?.instructions).toBe('');
    const otherConnection = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, modelSelection: ProviderBoundModelRefSchema.parse({ ...request.modelSelection, providerConnectionId: 'connection-b' }) } });
    expect(otherConnection?.intentInput).not.toHaveProperty('cachedOutput');
    const bypassed = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, intentInput: { ...request.intentInput, cachePolicy: { mode: 'bypass' },
        cachedOutput: { success: true, summaryMarkdown: 'Caller-injected saved prose' }, scmAnalysis: { phase: 'done' },
        reviewExplanation: { targets: [{ stopId: 'stop', findingRefs: [{ runId: 'review', findingId: 'finding' }] }],
          requestedBy: { kind: 'user', id: 'spoofed-user' }, requestedAtMs: 1 } } } });
    expect(bypassed?.intentInput).not.toHaveProperty('cachedOutput');
    expect(bypassed?.intentInput).not.toHaveProperty('scmAnalysis');
    expect(bypassed?.intentInput).not.toHaveProperty('reviewExplanation');
    const walkthrough = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, intentInput: { ...request.intentInput, outputs: ['walkthrough'] } } });
    expect(walkthrough?.intentInput).not.toHaveProperty('cachedOutput');
    expect(String(walkthrough?.instructions).includes('"summaryMarkdown":')).toBe(false);
    const withoutSelector = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, modelId: undefined, modelSelection: undefined, intentInput: { ...request.intentInput, resolvedSelector: { catalogId: 'profile:fast-summary' } } } });
    ScmDiffSummaryProfile.onBoundedComplete({ start: start(withoutSelector?.intentInput), finishedAtMs: 2,
      rawText: '{"summaryMarkdown":"Default model explanation."}' });
    const defaultAgain = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, modelId: undefined, modelSelection: undefined, intentInput: { ...request.intentInput, resolvedSelector: { catalogId: 'profile:fast-summary' } } } });
    expect(defaultAgain?.intentInput).not.toHaveProperty('cachedOutput');
    const mismatched = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, modelId: 'desired-other-model', modelSelection: undefined } });
    ScmDiffSummaryProfile.onBoundedComplete({ start: start(mismatched?.intentInput, 'actual-different-model'), finishedAtMs: 2,
      rawText: '{"summaryMarkdown":"Mismatch must not seed desired cache."}' });
    const mismatchAgain = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, modelId: 'desired-other-model', modelSelection: undefined } });
    expect(mismatchAgain?.intentInput).not.toHaveProperty('cachedOutput');
    await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'sess-2' });
    const otherSession = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-2', request });
    expect(otherSession?.intentInput).not.toHaveProperty('cachedOutput');
    const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Saved', intro: '', stops: [], otherChangeRefs: refs,
      } } }, analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] },
    }) });
    const seeded = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', contextWindowTokens: 1, request: {
      ...request, intentInput: { ...request.intentInput, resultId: saved.resultId, expectedRevision: 0, outputs: ['walkthrough'] },
    } });
    expect(seeded?.instructions).toContain('replacement generator');
    // A saved-result conversation is not itself a generation request. Capacity
    // reporting must not grant a whole-result multipart publication authority.
    expect((seeded?.intentInput as Record<string, unknown>).scmAnalysis).toBeUndefined();
    expect(seeded?.instructions).toContain('"otherChangeRefs":["c1"]');
    for (const ref of refs) expect(seeded?.instructions).not.toContain(ref);
  });
});
