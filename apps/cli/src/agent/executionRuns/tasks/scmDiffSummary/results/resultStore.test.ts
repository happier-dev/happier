import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScmComparisonSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryGenerateSuccessSchema, ScmDiffSummaryResultEditSchema } from '@happier-dev/protocol';
import { createScmDiffSummaryResultStore } from './resultStore';
import { presentReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';

const cwd = '/repo';
const comparison = ScmComparisonSchema.parse({
  id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
  inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
    binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-a\n+b' },
    occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', before: { startLine: 1, lineCount: 1 },
      after: { startLine: 1, lineCount: 1 }, position: 0 },
      { id: 'change-2', alias: 'c2', path: 'a.ts', before: { startLine: 3, lineCount: 1 },
        after: { startLine: 3, lineCount: 1 }, position: 1 }],
  }] },
});
const output = ScmDiffSummaryGenerateSuccessSchema.parse({ success: true, sourceKey: comparison.id, comparison,
  metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['summary', 'walkthrough', 'commitPlan'],
  summaryMarkdown: 'Keep the summary', outputs: {
    summary: { state: 'complete', value: { summaryMarkdown: 'Keep the summary' } },
    walkthrough: { state: 'complete', value: { title: 'Original', intro: 'Intro', stops: [
      { id: 's1', title: 'First', explanationMarkdown: 'First explanation', changeRefs: ['change-1'] },
      { id: 's2', title: 'Second', explanationMarkdown: 'Second explanation', changeRefs: ['change-2'] },
    ], otherChangeRefs: [] } },
    commitPlan: { state: 'complete', value: { groups: [{ id: 'g1', message: 'fix: a', rationale: 'Keep plan',
      changeRefs: ['change-1', 'change-2'] }], leftOutChangeRefs: [] } },
  }, analysis: { suppliedChangeRefs: ['change-1', 'change-2'], analysedChangeRefs: ['change-1', 'change-2'], remainingChangeRefs: [] },
});
const modelWalkthrough = { ...output.outputs!.walkthrough!.value!, stops: [
  { ...output.outputs!.walkthrough!.value!.stops[0]!, changeRefs: ['c1'] },
  { ...output.outputs!.walkthrough!.value!.stops[1]!, changeRefs: ['c2'] },
] };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-results-'));
  const store = createScmDiffSummaryResultStore({ directory });
  const created = await store.create({ cwd, sessionId: 'session-1', output });
  return { directory, store, request: { cwd, sessionId: 'session-1', resultId: created.resultId } };
}

async function setupPartialApplication() {
  const { store, request } = await setup();
  const moved = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'moveCommitChanges',
    changeRefs: ['change-2'], target: { kind: 'newGroup', group: { id: 'g2', message: 'fix: second', rationale: 'Second' } },
  } });
  if (!moved.success) throw new Error('Could not prepare two groups');
  const plan = moved.result.output.outputs!.commitPlan!.value!;
  expect(await store.beginRefinement({ ...request, expectedRevision: 1, output: 'commitPlan', inputId: 'before-application' }))
    .toMatchObject({ success: true });
  expect(await store.beginApplication({ ...request, expectedRevision: 1, acceptance: {
    ...plan, comparisonId: comparison.id, repositoryRootPath: cwd, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main',
  } })).toMatchObject({ success: true });
  expect(await store.mutateApplication(request, (result) => ({ ...result.application!, status: 'failed', nextGroupIndex: 1,
    steps: [{ groupId: 'g1', state: 'published', commitSha: 'b'.repeat(40), actualMessage: 'Hook-rewritten actual message' },
      { groupId: 'g2', state: 'not_published' }],
  }))).toMatchObject({ success: true, result: { revision: 3 } });
  return { store, request, plan };
}

describe('saved SCM result owner', () => {
  it('normalizes additive stored fields across read, inventory and canonical edit writes without relaxing known fields or model inputs', async () => {
    const { directory, store, request } = await setup();
    const file = join(directory, `${request.resultId}.json`);
    const renamed = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Stored title' } });
    if (!renamed.success) throw new Error(renamed.error);
    await store.beginInput({ ...request, inputId: 'pending', expectedRevision: 1, outputs: ['summary'] });
    const canonical = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const withExtras = { ...canonical, future: true,
      result: { ...renamed.result, future: true, output: { ...renamed.result.output, future: true,
        comparison: { ...comparison, future: true, repository: { ...comparison.repository, future: true },
          inventory: { ...comparison.inventory, future: true, files: comparison.inventory.files.map(file => ({ ...file,
            future: true, evidence: { ...file.evidence, future: true },
            occurrences: file.occurrences.map(occurrence => ({ ...occurrence, future: true, before: { ...occurrence.before, future: true } })),
          })) } },
      }, walkthroughProvenance: { ...renamed.result.walkthroughProvenance, future: true } },
      undoOutput: { ...output, future: true },
      inputs: [{ inputId: 'pending', baseRevision: 1, outputs: ['summary'], future: true }],
      generation: { key: 'stored-key', future: true },
    };
    await writeFile(file, JSON.stringify(withExtras));
    expect(await store.read(request)).toEqual(renamed);
    expect(await store.list()).toMatchObject({ count: 1, results: [{ resultId: request.resultId, title: 'Stored title', revision: 1 }] });
    expect(await store.readInput({ ...request, inputIds: ['pending'] })).toEqual({ inputId: 'pending', baseRevision: 1, outputs: ['summary'] });
    expect(await store.read({ ...request, cwd: '/another-repo' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await store.read({ ...request, sessionId: 'another-session' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Stale' } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.publish({ ...request, inputId: 'pending', modelOutput: { summaryMarkdown: 'Invalid', future: true } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Current' } }))
      .toMatchObject({ success: true, result: { revision: 2 } });
    expect(await readFile(file, 'utf8')).not.toContain('"future"');
    await writeFile(file, JSON.stringify({ ...withExtras, result: { ...withExtras.result, revision: -1 } }));
    await expect(store.read(request)).rejects.toThrow();
    await expect(store.list()).rejects.toThrow();
  });
  it('keeps the admitted revision basis when only same-input multipart admission progress changes', async () => {
    const store = createScmDiffSummaryResultStore({ directory: await mkdtemp(join(tmpdir(), 'scm-part-admission-')) });
    const created = await store.create({ cwd: '/repo', output });
    const scope = { cwd: '/repo', resultId: created.resultId };
    await store.beginInput({ ...scope, inputId: 'part', expectedRevision: created.revision, outputs: ['summary'] });
    const progress = await store.publishProgress({ ...scope, inputId: 'part', expectedRevision: created.revision, preserveUndo: true,
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...created.output, analysis: { ...created.output.analysis,
        parts: { admitted: 2, completed: 1, total: 3, phase: 'evidence' } } }) });
    expect(progress).toMatchObject({ success: true });
    const published = await store.publish({ ...scope, inputId: 'part', modelOutput: { summaryMarkdown: 'Completed part' } });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { summary: { value: { summaryMarkdown: 'Completed part' } } } } } });
    if (!published.success) throw new Error(published.error);
    await store.beginInput({ ...scope, inputId: 'next-part', expectedRevision: published.result.revision, outputs: ['summary'] });
    const nextProgress = await store.publishProgress({ ...scope, inputId: 'next-part', expectedRevision: published.result.revision,
      preserveUndo: true, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...published.result.output,
        analysis: { ...published.result.output.analysis, parts: { admitted: 3, completed: 2, total: 3, phase: 'evidence' } } }) });
    if (!nextProgress.success) throw new Error(nextProgress.error);
    await store.edit({ ...scope, expectedRevision: nextProgress.result.revision,
      edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'Manual intervening edit' } } });
    expect(await store.publish({ ...scope, inputId: 'next-part', modelOutput: { summaryMarkdown: 'Late model output' } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const current = await store.read(scope);
    if (!current.success) throw new Error(current.error);
    const later = await store.publishProgress({ ...scope, expectedRevision: current.result.revision,
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...current.result.output, summaryMarkdown: 'Later native part', outputs: { ...current.result.output.outputs,
        summary: { state: 'writing', value: { summaryMarkdown: 'Later native part' } } },
        analysis: { ...current.result.output.analysis, parts: { admitted: 4, completed: 3, total: 4, phase: 'merge' } } }) });
    if (!later.success) throw new Error(later.error);
    expect(await store.undo({ ...scope, expectedRevision: later.result.revision })).toMatchObject({ success: true, result: {
      output: { outputs: { summary: { value: { summaryMarkdown: 'Manual intervening edit' } } },
        analysis: { parts: { admitted: 4, completed: 3, total: 4, phase: 'merge' } } },
    } });
  });
  it('projects edited titles, moved/changed stops and the immediate update notice across reload and Undo', async () => {
    const { directory, store, request } = await setup();
    const renamed = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's2', title: 'My title' } });
    expect(renamed).toMatchObject({ success: true, result: { walkthroughProvenance: { stops: [
      { stopId: 's1', titleEdited: false }, { stopId: 's2', titleEdited: true, changedAtRevision: 1 },
    ] }, updateNotice: { kind: 'edit', revision: 1, affectedStopIds: ['s2'] } } });
    const moved = await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'reorderStops', stopIds: ['s2', 's1'] } });
    expect(moved).toMatchObject({ success: true, result: { walkthroughProvenance: { stops: [
      { stopId: 's2', titleEdited: true, movedAtRevision: 2 }, { stopId: 's1', movedAtRevision: 2 },
    ] } } });
    const merged = await store.edit({ ...request, expectedRevision: 2, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'],
      targetStopId: 's2', explanationMarkdown: 'Together' } });
    expect(merged).toMatchObject({ success: true, result: { updateNotice: { kind: 'edit', revision: 3,
      mergedStopIds: ['s1', 's2'] }, walkthroughProvenance: { stops: [{ stopId: 's2', titleEdited: true,
      changedAtRevision: 3 }] } } });
    const reloaded = createScmDiffSummaryResultStore({ directory });
    expect(await reloaded.read(request)).toEqual(merged);
    const undone = await reloaded.undo({ ...request, expectedRevision: 3 });
    expect(undone).toMatchObject({ success: true, result: { canUndo: false, updateNotice: { kind: 'undo', revision: 4 },
      walkthroughProvenance: { stops: [{ stopId: 's2', titleEdited: true, movedAtRevision: 2 }, { stopId: 's1', titleEdited: false }] } } });
  });
  it('joins generation from another host owner, returns current edits, and honors explicit bypass', async () => {
    const { directory, store } = await setup();
    const anotherHost = createScmDiffSummaryResultStore({ directory });
    const input = { cwd, sessionId: 'session-1', key: 'comparison-and-selection', outputs: output.requestedOutputs! };
    const generate = async () => {
      const saved = await store.create({ cwd, sessionId: input.sessionId, output });
      return { ...saved.output, runId: `run-${saved.resultId}` };
    };
    const [first, second] = await Promise.all([
      store.admitGeneration(input, generate), anotherHost.admitGeneration(input, generate),
    ]);
    expect(second).toMatchObject({ resultId: first.resultId, runId: first.runId });
    const scope = { cwd, sessionId: input.sessionId, resultId: first.resultId! };
    await store.edit({ ...scope, expectedRevision: first.revision!, edit: { kind: 'renameWalkthrough', title: 'Manual title' } });
    const reuse = await anotherHost.admitGeneration(input, async () => { throw new Error('Must reuse saved edits'); });
    expect(reuse).toMatchObject({ resultId: first.resultId, revision: first.revision! + 1,
      outputs: { walkthrough: { value: { title: 'Manual title' } } } });
    const bypassed = await anotherHost.admitGeneration({ ...input, bypass: true }, generate);
    expect(bypassed.resultId).not.toBe(first.resultId);
    await store.edit({ ...scope, expectedRevision: reuse.revision!, edit: { kind: 'removeOutput', output: 'walkthrough' } });
    await anotherHost.delete({ cwd, sessionId: input.sessionId, resultId: bypassed.resultId!, expectedRevision: bypassed.revision! });
    const afterDiscard = await anotherHost.admitGeneration(input, generate);
    expect(afterDiscard.resultId).not.toBe(first.resultId);
    expect(afterDiscard.outputs?.walkthrough?.state).toBe('complete');
  });

  it('retains ambiguous admission failure without retrying until an explicit bypass', async () => {
    const { store } = await setup();
    const input = { cwd, sessionId: 'session-1', key: 'ambiguous-admission', outputs: ['summary'] as const };
    const failed = await store.admitGeneration(input, async () => {
      const saved = await store.create({ cwd, sessionId: input.sessionId, output: { ...output, requestedOutputs: ['summary'],
        outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } } } });
      return saved.output;
    });
    expect(await store.admitGeneration(input, async () => { throw new Error('Unsafe automatic retry'); }))
      .toMatchObject({ resultId: failed.resultId, outputs: { summary: { state: 'failed' } } });
    const retry = await store.admitGeneration({ ...input, bypass: true }, async () => (await store.create({ cwd,
      sessionId: input.sessionId, output })).output);
    expect(retry.resultId).not.toBe(failed.resultId);
  });

  it('encodes genuine special finding identities without permitting delimiter injection or encoded canonical spoofing', async () => {
    const { store, request } = await setup();
    const citations = [
      { alias: 'F1', runId: 'review', findingId: 'same (id)' },
      { alias: 'F2', runId: 'review', findingId: 'bad) [spoof](finding:other)' },
      { alias: 'F3', runId: 'review', findingId: '\ud800' },
      { alias: 'F4', runId: 'review', findingId: 'literal%20id' },
    ];
    await store.beginInput({ ...request, inputId: 'special-ids', outputs: ['walkthrough'], reviewFindingCitations: citations });
    const published = await store.publish({ ...request, inputId: 'special-ids', modelOutput: { walkthrough: {
      ...modelWalkthrough, stops: [
        { ...modelWalkthrough.stops[0], findingRefs: citations.map(item => item.alias), explanationMarkdown:
          '[spaced](finding:F1) [delimiter](finding:F2) [invalid](finding:F3) [literal](finding:F4) [spoof](finding:review:same%20%28id%29)' },
        modelWalkthrough.stops[1],
      ],
    } } });
    const markdown = '[spaced](finding:review:same%20%28id%29) [delimiter](finding:review:bad%29%20%5Bspoof%5D%28finding:other%29) invalid [literal](finding:review:literal%2520id) spoof';
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: citations.map(item => `${item.runId}:${item.findingId}`), explanationMarkdown: markdown },
      output.outputs!.walkthrough!.value!.stops[1],
    ] } } } } } });
    if (!published.success) throw new Error('Special identities did not publish');
    const presented = presentReviewFindingCitations(published.result.output.outputs!.walkthrough!.value!.stops[0], citations);
    expect(presented).toMatchObject({ findingRefs: ['F1', 'F2', 'F3', 'F4'],
      explanationMarkdown: '[spaced](finding:F1) [delimiter](finding:F2) invalid [literal](finding:F4) spoof' });
    expect(presentReviewFindingCitations('[invalid](finding:review:%ZZ)', citations)).toBe('invalid');
    const carried = await store.publishProgress({ ...request, expectedRevision: published.result.revision, output: published.result.output });
    expect(carried).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { explanationMarkdown: markdown }, output.outputs!.walkthrough!.value!.stops[1],
    ] } } } } } });
  });
  it('publishes only admitted stop-scoped finding aliases and strips canonical spoof links', async () => {
    const { store, request } = await setup();
    const admission = { ...request, inputId: 'citations', expectedRevision: 0, outputs: ['walkthrough'] as const,
      reviewFindingCitations: [
        { alias: 'F1', runId: 'review-a', findingId: 'same-id' },
        { alias: 'F2', runId: 'review-b', findingId: 'same-id' },
      ] };
    await store.beginInput(admission);
    const published = await store.publish({ ...request, inputId: 'citations', modelOutput: { walkthrough: {
      ...modelWalkthrough, stops: [
        { ...modelWalkthrough.stops[0], findingRefs: ['F1', 'F99'], explanationMarkdown:
          '[first](finding:F1) [outside](finding:F2) [missing](finding:F99) [spoof](finding:review-a:same-id) [titled](finding:review-a:same-id "title") [wrapped](<finding:review-a:same-id>)' },
        { ...modelWalkthrough.stops[1], findingRefs: ['F2'], explanationMarkdown: '[second](finding:F2)' },
      ],
    } } });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: ['review-a:same-id'], explanationMarkdown: '[first](finding:review-a:same-id) outside missing spoof titled wrapped' },
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[second](finding:review-b:same-id)' },
    ] } } } } } });
  });
  it('does not preserve old unvalidated canonical citations through progressive carryforward', async () => {
    const { store, request } = await setup();
    const walkthrough = output.outputs!.walkthrough!.value!;
    const oldOutput = { ...output, outputs: { ...output.outputs, walkthrough: { state: 'complete' as const,
      value: { ...walkthrough, stops: walkthrough.stops.map(stop => ({ ...stop, findingRefs: ['spoof:unpublished'],
        explanationMarkdown: '[old](finding:spoof:unpublished)' })) } } } };
    const old = await store.create({ cwd, sessionId: request.sessionId, output: oldOutput });
    const published = await store.publishProgress({ cwd, sessionId: request.sessionId, resultId: old.resultId,
      expectedRevision: 0, output: oldOutput });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: [], explanationMarkdown: 'old' }, { findingRefs: [], explanationMarkdown: 'old' },
    ] } } } } } });
  });
  it('uses the exact admitted input finding identity for progressive publication, not another pending alias map', async () => {
    const { store, request } = await setup();
    await store.beginInput({ ...request, inputId: 'earlier', expectedRevision: 0, outputs: ['walkthrough'],
      reviewFindingCitations: [{ alias: 'F1', runId: 'review-a', findingId: 'same-id' }] });
    await store.beginInput({ ...request, inputId: 'current', expectedRevision: 0, outputs: ['walkthrough'],
      reviewFindingCitations: [{ alias: 'F1', runId: 'review-b', findingId: 'same-id' }] });
    const publication = { ...request, expectedRevision: 0, inputId: 'current', output: { ...output,
      outputs: { ...output.outputs, walkthrough: { state: 'writing' as const, value: { ...output.outputs!.walkthrough!.value!,
        stops: output.outputs!.walkthrough!.value!.stops.map(stop => ({ ...stop, findingRefs: ['F1'], explanationMarkdown: '[current](finding:F1)' })) } } } } };
    expect(await store.publishProgress(publication)).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[current](finding:review-b:same-id)' },
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[current](finding:review-b:same-id)' },
    ] } } } } } });
  });
  it('publishes a separate host-attributed finding explanation without rewriting prose and supports stale-safe Undo', async () => {
    const { store, request } = await setup();
    const targets = [{ stopId: 's1', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }];
    const askedBy = { kind: 'user' as const };
    const begun = await store.beginInput({ ...request, inputId: 'explain', expectedRevision: 0,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    expect(begun).toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { walkthrough: output.outputs!.walkthrough!.value } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { reviewExplanations: [
      { stopId: 's2', markdown: 'Wrong target' },
    ] } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    const published = await store.publish({ ...request, inputId: 'explain',
      modelId: 'selected-model', runId: 'narrator-1', generatedAtMs: 1234,
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Why this finding matters.' }] } });
    expect(published).toMatchObject({ success: true, result: { revision: 1, canUndo: true, output: {
      outputs: { summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan, walkthrough: { value: {
        stops: [{ ...output.outputs!.walkthrough!.value!.stops[0], reviewExplanations: [{ markdown: 'Why this finding matters.',
          findingRefs: targets[0]!.findingRefs, provenance: { requestedBy: askedBy,
            requestedAtMs: expect.any(Number), generatedAtMs: 1234, modelId: 'selected-model', runId: 'narrator-1' } }] }, output.outputs!.walkthrough!.value!.stops[1]],
      } } },
    } } });
    if (!published.success) throw new Error('Explanation did not publish');
    const explained = published.result.output.outputs!.walkthrough!.value!;
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'replaceWalkthrough', value: {
      ...explained, stops: explained.stops.map(stop => stop.reviewExplanations ? { ...stop,
        reviewExplanations: stop.reviewExplanations.map(block => ({ ...block, provenance: { ...block.provenance, modelId: 'forged' } })),
      } : stop),
    } } })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    await store.beginInput({ ...request, inputId: 'stale-explain', expectedRevision: 1,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'renameStop', stopId: 's2', title: 'My edit' } });
    expect(await store.publish({ ...request, inputId: 'stale-explain',
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Stale explanation' }] } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const undoneRename = await store.undo({ ...request, expectedRevision: 2 });
    expect(undoneRename).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: {
      stops: [{ reviewExplanations: [{ markdown: 'Why this finding matters.' }] }, { title: 'Second' }],
    } } } } } });
    const fresh = await setup();
    await fresh.store.beginInput({ ...fresh.request, inputId: 'explain', expectedRevision: 0,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    await fresh.store.publish({ ...fresh.request, inputId: 'explain', modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Explanation' }] } });
    expect(await fresh.store.undo({ ...fresh.request, expectedRevision: 1 }))
      .toMatchObject({ success: true, result: { revision: 2, output: { outputs: output.outputs } } });
  });
  it('preserves host explanations through whole refinement only for unchanged stop selections', async () => {
    const { store, request } = await setup();
    await store.beginInput({ ...request, inputId: 'explain', outputs: ['walkthrough'], stopIds: ['s1'],
      reviewExplanation: { targets: [{ stopId: 's1', findingRefs: [{ runId: 'review', findingId: 'finding' }] }],
        requestedBy: { kind: 'user' } } });
    const explained = await store.publish({ ...request, inputId: 'explain', modelId: 'model', runId: 'run',
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Separate explanation' }] } });
    if (!explained.success) throw new Error(explained.error);
    const blocks = explained.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations;
    const refine = async (inputId: string, revision: number, swap: boolean) => {
      await store.beginRefinement({ ...request, inputId, expectedRevision: revision, output: 'walkthrough' });
      return store.publish({ ...request, inputId, modelOutput: { walkthrough: {
        ...output.outputs!.walkthrough!.value!, stops: output.outputs!.walkthrough!.value!.stops.map((stop, index) => ({
          ...stop, explanationMarkdown: 'Refined prose', changeRefs: [swap ? `c${2 - index}` : `c${index + 1}`],
        })),
      } } });
    };
    const refined = await refine('whole', 1, false);
    expect(refined).toMatchObject({ success: true, result: { revision: 2, output: { outputs: { walkthrough: { value: {
      stops: [{ explanationMarkdown: 'Refined prose', reviewExplanations: blocks }, {}],
    } } } } } });
    if (!refined.success) throw new Error(refined.error);
    // An explicit user replacement can remove the separate block.
    const withoutBlocks = { ...refined.result.output.outputs!.walkthrough!.value!,
      stops: refined.result.output.outputs!.walkthrough!.value!.stops.map(({ reviewExplanations: _blocks, ...stop }) => stop) };
    const removed = await store.edit({ ...request, expectedRevision: 2, edit: { kind: 'replaceWalkthrough', value: withoutBlocks } });
    expect(removed.success && removed.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations).toBeUndefined();
    await store.undo({ ...request, expectedRevision: 3 });
    const changed = await refine('changed-selection', 4, true);
    expect(changed.success && changed.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations).toBeUndefined();
    const forged = await store.beginRefinement({ ...request, inputId: 'forged', expectedRevision: 5, output: 'walkthrough' });
    expect(forged.success).toBe(true);
    expect(await store.publish({ ...request, inputId: 'forged', modelOutput: { walkthrough: {
      ...output.outputs!.walkthrough!.value!, stops: [{ ...output.outputs!.walkthrough!.value!.stops[0]!, reviewExplanations: blocks },
        output.outputs!.walkthrough!.value!.stops[1]!],
    } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
  });
  it('keeps separate finding explanation attribution when the user merges stops', async () => {
    const { store, request } = await setup();
    const targets = ['s1', 's2'].map(stopId => ({ stopId, findingRefs: [{ runId: 'review', findingId: stopId }] }));
    await store.beginInput({ ...request, inputId: 'explain', expectedRevision: 0, outputs: ['walkthrough'], stopIds: ['s1', 's2'],
      reviewExplanation: { targets, requestedBy: { kind: 'agent', id: 'session' } } });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { reviewExplanations: targets.map(target => ({ stopId: target.stopId, markdown: target.stopId })) } }))
      .toMatchObject({ success: true });
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'], targetStopId: 's1', explanationMarkdown: 'Merged prose' } }))
      .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [{ explanationMarkdown: 'Merged prose',
        reviewExplanations: [{ markdown: 's1', findingRefs: targets[0]!.findingRefs }, { markdown: 's2', findingRefs: targets[1]!.findingRefs }],
      }] } } } } } });
  });
  it('lists every saved machine result from protected disk with exact revisions, scopes and byte totals', async () => {
    const { directory, store, request } = await setup();
    const another = await store.create({ cwd: '/other', output });
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'My saved title' } });
    await utimes(join(directory, `${request.resultId}.json`), 2, 2);
    await utimes(join(directory, `${another.resultId}.json`), 1, 1);
    await writeFile(join(directory, 'unrelated.tmp'), 'unrelated');
    const reopened = createScmDiffSummaryResultStore({ directory });
    const listed = await reopened.list();
    expect(listed.count).toBe(2);
    expect(listed.results.map(item => ({ resultId: item.resultId, updatedAtMs: item.updatedAtMs })))
      .toEqual([{ resultId: request.resultId, updatedAtMs: 2000 }, { resultId: another.resultId, updatedAtMs: 1000 }]);
    expect(listed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...request, revision: 1, comparisonId: comparison.id, title: 'My saved title', source: comparison.source }),
      expect.objectContaining({ cwd: '/other', resultId: another.resultId, revision: 0 }),
    ]));
    const bytes = (await readFile(join(directory, `${request.resultId}.json`))).byteLength
      + (await readFile(join(directory, `${another.resultId}.json`))).byteLength;
    expect(listed.bytes).toBe(bytes);
    expect(listed.results.reduce((total, item) => total + item.bytes, 0)).toBe(bytes);
    expect(await reopened.delete({ ...request, expectedRevision: 0 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await reopened.delete({ ...request, expectedRevision: 1 })).toMatchObject({ success: true });
    expect((await reopened.list()).results.map(item => item.resultId)).toEqual([another.resultId]);
  });
  it('moves exact commit selections to new groups, left out and existing groups without changing other outputs', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    expect(await edit(0, { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'newGroup',
      group: { id: 'g2', message: 'fix: second', rationale: 'Separate second occurrence' } } }))
      .toMatchObject({ success: true, result: { revision: 1, output: { outputs: { commitPlan: { value: {
        groups: [{ id: 'g1', changeRefs: ['change-1'] }, { id: 'g2', changeRefs: ['change-2'] }], leftOutChangeRefs: [],
      } } } } } });
    expect(await edit(1, { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'leftOut' } }))
      .toMatchObject({ success: true, result: { revision: 2, output: { outputs: { commitPlan: { value: {
        groups: [{ id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2'] }], leftOutChangeRefs: ['change-1'],
      } } } } } });
    const moved = await edit(2, { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'group', groupId: 'g2' } });
    expect(moved).toMatchObject({ success: true, result: { revision: 3, canUndo: true, output: {
      summaryMarkdown: output.summaryMarkdown, analysis: output.analysis, outputs: { summary: output.outputs?.summary,
        walkthrough: output.outputs?.walkthrough, commitPlan: { value: {
          groups: [{ id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2', 'change-1'] }], leftOutChangeRefs: [],
        } } },
    } } });
    expect(await edit(2, { kind: 'editCommitGroup', groupId: 'g2', message: 'stale' }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 3 });
    expect(await store.undo({ ...request, expectedRevision: 2 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.undo({ ...request, expectedRevision: 3 })).toMatchObject({ success: true, result: { revision: 4,
      output: { outputs: { commitPlan: { value: { leftOutChangeRefs: ['change-1'], groups: [
        { id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2'] },
      ] } } } } } });
  });

  it('discards one output as a revisioned edit that Undo restores, never the last output or a landed proposal', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    const removed = await edit(0, { kind: 'removeOutput', output: 'commitPlan' });
    expect(removed).toMatchObject({ success: true, result: { revision: 1, canUndo: true,
      output: { requestedOutputs: ['summary', 'walkthrough'], outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough } } } });
    expect(removed.success && removed.result.output.outputs?.commitPlan).toBeUndefined();
    expect(await edit(0, { kind: 'removeOutput', output: 'walkthrough' })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.undo({ ...request, expectedRevision: 1 })).toMatchObject({ success: true, result: { revision: 2,
      output: { outputs: { commitPlan: output.outputs?.commitPlan } } } });
    expect(await edit(2, { kind: 'removeOutput', output: 'summary' })).toMatchObject({ success: true, result: { revision: 3 } });
    expect(await edit(3, { kind: 'removeOutput', output: 'walkthrough' })).toMatchObject({ success: true, result: { revision: 4 } });
    // The last output is the result itself: delete it instead.
    expect(await edit(4, { kind: 'removeOutput', output: 'commitPlan' })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    const partial = await setupPartialApplication();
    expect(await partial.store.edit({ ...partial.request, expectedRevision: 3, edit: { kind: 'removeOutput', output: 'commitPlan' } }))
      .toMatchObject({ success: false, errorCode: 'invalid_edit' });
  });

  it('reorders and merges commit groups while retaining the edited target unless explicitly replaced', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    await edit(0, { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'newGroup',
      group: { id: 'g2', message: 'fix: second', rationale: 'Second' } } });
    await edit(1, { kind: 'editCommitGroup', groupId: 'g2', message: 'My message', rationale: 'My rationale' });
    expect(await edit(2, { kind: 'reorderCommitGroups', groupIds: ['g2', 'g1'] })).toMatchObject({ success: true,
      result: { revision: 3, output: { outputs: { commitPlan: { value: { groups: [{ id: 'g2' }, { id: 'g1' }] } } } } } });
    expect(await edit(3, { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g2' }))
      .toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: { groups: [
        { id: 'g2', message: 'My message', rationale: 'My rationale', changeRefs: ['change-2', 'change-1'] },
      ] } } } } } });
    await store.undo({ ...request, expectedRevision: 4 });
    expect(await edit(5, { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g2',
      message: 'Explicit merged message', rationale: '' })).toMatchObject({ success: true,
      result: { revision: 6, output: { outputs: { commitPlan: { value: { groups: [
        { id: 'g2', message: 'Explicit merged message', rationale: '', changeRefs: ['change-2', 'change-1'] },
      ] } } } } } });
  });

  it('rejects invalid commit edits without changing revision, coverage or Undo', async () => {
    const { store, request } = await setup();
    for (const command of [
      { kind: 'moveCommitChanges', changeRefs: ['c1'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['foreign-change'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'group', groupId: 'missing' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'newGroup', group: { id: 'g1', message: 'Duplicate', rationale: '' } } },
      { kind: 'reorderCommitGroups', groupIds: ['missing'] },
      { kind: 'mergeCommitGroups', groupIds: ['g1', 'missing'], targetGroupId: 'g1' },
      { kind: 'editCommitGroup', groupId: 'missing', rationale: '' },
    ]) {
      expect(await store.edit({ ...request, expectedRevision: 0, edit: ScmDiffSummaryResultEditSchema.parse(command) }))
        .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    }
    expect(await store.read(request)).toMatchObject({ success: true, result: { revision: 0, canUndo: false,
      output: { outputs: output.outputs } } });
  });

  it('refuses a commit-plan replacement on historical comparison evidence', async () => {
    const { store } = await setup();
    const historical = { ...comparison, source: { kind: 'commit' as const, commit: 'abc' } };
    const created = await store.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      comparison: historical, metadata: { ...output.metadata, source: historical.source }, requestedOutputs: ['summary', 'walkthrough'],
      outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough },
    }) });
    expect(await store.edit({ cwd, resultId: created.resultId, expectedRevision: 0,
      edit: { kind: 'replaceCommitPlan', value: output.outputs!.commitPlan!.value! } }))
      .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    expect(await store.read({ cwd, resultId: created.resultId })).toMatchObject({ success: true, result: { revision: 0, canUndo: false } });
  });

  it('allows remaining edits after a partial application but preserves the landed prefix and its original proposal', async () => {
    const { store, request, plan } = await setupPartialApplication();
    for (const command of [
      { kind: 'editCommitGroup', groupId: 'g1', message: 'Rewritten landed proposal' },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'group', groupId: 'g1' } },
      { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g1' },
      { kind: 'reorderCommitGroups', groupIds: ['g2', 'g1'] },
      { kind: 'replaceCommitPlan', value: { ...plan, groups: plan.groups.slice(1), leftOutChangeRefs: ['change-1'] } },
    ]) {
      expect(await store.edit({ ...request, expectedRevision: 3, edit: ScmDiffSummaryResultEditSchema.parse(command) }))
        .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    }
    expect(await store.edit({ ...request, expectedRevision: 3, edit: ScmDiffSummaryResultEditSchema.parse({
      kind: 'editCommitGroup', groupId: 'g2', message: 'Fresh remaining proposal',
    }) })).toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: { groups: [
      plan.groups[0], { id: 'g2', message: 'Fresh remaining proposal', changeRefs: ['change-2'] },
    ] } } } } } });
  });

  it('rejects Undo that resurrects landed selections while allowing remaining and unrelated summary Undo', async () => {
    const { store, request, plan } = await setupPartialApplication();
    // The pre-application Undo contains one group with both changes, so applying it would steal the remaining selection.
    expect(await store.undo({ ...request, expectedRevision: 3 })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    expect(await store.edit({ ...request, expectedRevision: 3, edit: { kind: 'editCommitGroup', groupId: 'g2', message: 'Remaining edit' } }))
      .toMatchObject({ success: true, result: { revision: 4 } });
    expect(await store.undo({ ...request, expectedRevision: 4 })).toMatchObject({ success: true, result: { revision: 5,
      output: { outputs: { commitPlan: { value: plan } } }, application: { steps: [
        { groupId: 'g1', state: 'published', commitSha: 'b'.repeat(40) }, { groupId: 'g2', state: 'not_published' },
      ] },
    } });
    expect(await store.edit({ ...request, expectedRevision: 5, edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'New summary' } } }))
      .toMatchObject({ success: true, result: { revision: 6 } });
    expect(await store.undo({ ...request, expectedRevision: 6 })).toMatchObject({ success: true, result: { revision: 7,
      output: { summaryMarkdown: output.summaryMarkdown, outputs: { commitPlan: { value: plan } } },
    } });
  });

  it('rejects stale or prefix-changing refinement publication after a partial application', async () => {
    const { store, request, plan } = await setupPartialApplication();
    expect(await store.publish({ ...request, inputId: 'before-application', modelOutput: { commitPlan: output.outputs!.commitPlan!.value } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 3 });
    expect(await store.beginRefinement({ ...request, expectedRevision: 3, output: 'commitPlan', inputId: 'after-application' }))
      .toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'after-application', modelOutput: { commitPlan: {
      groups: plan.groups.slice(1).map(group => ({ ...group, changeRefs: ['c2'] })), leftOutChangeRefs: ['c1'],
    } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.read(request)).toMatchObject({ success: true, result: { revision: 3, output: { outputs: { commitPlan: { value: plan } } } } });
    expect(await store.beginRefinement({ ...request, expectedRevision: 3, output: 'summary', inputId: 'summary-after-application' }))
      .toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'summary-after-application', modelOutput: { summaryMarkdown: 'Updated analysis' } }))
      .toMatchObject({ success: true, result: { revision: 4, output: { summaryMarkdown: 'Updated analysis', outputs: { commitPlan: { value: plan } } } } });
  });

  it('rejects a terminal progress envelope that removes or changes the landed proposal', async () => {
    const { store, request, plan } = await setupPartialApplication();
    for (const next of [
      { ...output, requestedOutputs: ['summary', 'walkthrough'], outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough } },
      output,
    ]) {
      expect(await store.publishProgress({ ...request, expectedRevision: 3, output: ScmDiffSummaryGenerateOutputSchema.parse(next) }))
        .toMatchObject({ success: false, errorCode: 'invalid_output' });
    }
    const current = await store.read(request);
    if (!current.success) throw new Error('Saved result is unavailable');
    expect(await store.publishProgress({ ...request, expectedRevision: 3, output: current.result.output }))
      .toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: plan } } } } });
  });

  it('keeps the last manual Undo when conversation provenance changes without undoing the new run linkage', async () => {
    const { store, request } = await setup();
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } });
    expect(await store.bindRun({ ...request, expectedRevision: 1, runId: 'replacement-run', seededFromRunId: 'previous-run' }))
      .toMatchObject({ success: true, result: { revision: 2, canUndo: true } });
    expect(await store.undo({ ...request, expectedRevision: 2 })).toMatchObject({ success: true,
      result: { revision: 3, canUndo: false, output: { runId: 'replacement-run', producer: { runId: 'replacement-run', seededFromRunId: 'previous-run' },
        outputs: { walkthrough: { value: { title: 'Original' } } } } } });
  });
  it('persists edits independently of runs/cache and rejects stale device writes across owner instances', async () => {
    const { store, directory, request } = await setup();
    const secondDevice = createScmDiffSummaryResultStore({ directory });
    const edited = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'My title' } });
    expect(edited).toMatchObject({ success: true, result: { revision: 1, canUndo: true } });
    const stale = await secondDevice.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Stale' } });
    expect(stale).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
    const read = await secondDevice.read(request);
    expect(read).toMatchObject({ success: true, result: { output: { summaryMarkdown: 'Keep the summary',
      outputs: { walkthrough: { value: { title: 'My title' } }, commitPlan: output.outputs?.commitPlan } } } });
    expect(await store.read({ ...request, sessionId: 'another-session' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
  });

  it('serializes two simultaneous revisions at the filesystem owner', async () => {
    const { directory, store, request } = await setup();
    const second = createScmDiffSummaryResultStore({ directory });
    const outcomes = await Promise.all([store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'A' } }),
      second.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'B' } })]);
    expect(outcomes.filter((result) => result.success)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.success)).toMatchObject([{ errorCode: 'revision_conflict', latestRevision: 1 }]);
  });

  it('merges exact coverage with the explicit title and supports revision-checked immediate Undo', async () => {
    const { store, request } = await setup();
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Edited title' } });
    const merged = await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'],
      targetStopId: 's1', explanationMarkdown: 'Merged explanation' } });
    expect(merged).toMatchObject({ success: true, result: { revision: 2, output: { outputs: { walkthrough: { value: {
      stops: [{ id: 's1', title: 'Edited title', explanationMarkdown: 'Merged explanation', changeRefs: ['change-1', 'change-2'] }],
    } } } } } });
    expect(await store.undo({ ...request, expectedRevision: 1 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const undone = await store.undo({ ...request, expectedRevision: 2 });
    expect(undone).toMatchObject({ success: true, result: { revision: 3, canUndo: false, output: { outputs: { walkthrough: { value: {
      stops: [{ id: 's1', title: 'Edited title', changeRefs: ['change-1'] }, { id: 's2', changeRefs: ['change-2'] }],
    } } } } } });
  });

  it('binds refinement before dispatch, refuses stale publication and validates aliases without losing outputs', async () => {
    const { store, request } = await setup();
    const begun = await store.beginRefinement({ ...request, expectedRevision: 0, output: 'walkthrough', stopIds: ['s1'], inputId: 'refine-1' });
    expect(begun).toMatchObject({ success: true });
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Device A' } });
    const stale = await store.publish({ ...request, inputId: 'refine-1', modelOutput: { walkthrough: {
      title: 'Ignored generated title', intro: '', stops: [{ id: 's1', title: 'First', explanationMarkdown: 'Updated', changeRefs: ['c1'] }], otherChangeRefs: [],
    } } });
    expect(stale).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
    await store.beginRefinement({ ...request, expectedRevision: 1, output: 'walkthrough', stopIds: ['s1'], inputId: 'refine-2' });
    for (const ref of ['other-comparison:c1', 'change-1']) {
      expect(await store.publish({ ...request, inputId: 'refine-2', modelOutput: { walkthrough: {
        title: 'Wrong', intro: '', stops: [{ id: 's1', title: 'First', explanationMarkdown: 'Updated', changeRefs: [ref] }], otherChangeRefs: [],
      } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    }
    const latest = await store.read(request);
    expect(latest).toMatchObject({ success: true, result: { revision: 1, output: { outputs: { walkthrough: { value: { title: 'Device A' } } } } } });
  });

  it('publishes targeted prose only, preserving manual titles, neighboring stops, summary and commit proposals', async () => {
    const { store, request } = await setup();
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Personal title' } });
    await store.beginRefinement({ ...request, expectedRevision: 1, output: 'walkthrough', stopIds: ['s1'], inputId: 'refine' });
    const updated = await store.publish({ ...request, inputId: 'refine', modelOutput: { walkthrough: {
      title: 'Model title', intro: 'Model intro', stops: [{ id: 's1', title: 'Model stop', explanationMarkdown: 'Refined first', changeRefs: ['c1'] }], otherChangeRefs: [],
    } } });
    expect(updated).toMatchObject({ success: true, result: { revision: 2, output: { summaryMarkdown: 'Keep the summary', outputs: {
      summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan,
      walkthrough: { value: { title: 'Original', intro: 'Intro', stops: [
        { id: 's1', title: 'Personal title', explanationMarkdown: 'Refined first', changeRefs: ['change-1'] }, output.outputs?.walkthrough?.value?.stops[1],
      ] } },
    } } } });
  });
});
