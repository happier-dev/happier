import { describe, expect, it } from 'vitest';
import { executeScmDiffSummaryClear } from './clearSavedResults.js';
import { ScmDiffSummaryResultSchema, ScmDiffSummaryResultClearResponseSchema } from './diffSummaryResult.js';
import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort } from './reviewedMarks.js';
import { buildScmReviewScopeId } from './comparisonOccurrences.js';

function fixture(sharedWith?: 'refused' | 'unselected', differentCapture = false) {
  const results = new Map(['deleted', 'refused', 'unselected'].map((resultId, index) => {
    const comparisonId = String(index + 1).repeat(64);
    const source = index === 0 ? { kind: 'workingTree' as const }
      : { kind: 'commit' as const, commit: String(index + 1).repeat(40) };
    return [resultId, ScmDiffSummaryResultSchema.parse({ resultId, revision: 1, canUndo: false,
      output: { success: true, resultId, revision: 1, sourceKey: comparisonId,
        metadata: { sourceKey: comparisonId, source },
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        comparison: { id: comparisonId, source,
          repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: resultId } } },
      } })] as const;
  }));
  const comparisons = [...results.values()].map(result => result.output.comparison!);
  if (sharedWith) {
    const sibling = results.get(sharedWith)!;
    sibling.output.comparison = { ...comparisons[0]!, id: differentCapture ? sibling.output.sourceKey : comparisons[0]!.id };
    sibling.output.sourceKey = sibling.output.comparison.id;
    sibling.output.metadata = { sourceKey: sibling.output.comparison.id, source: comparisons[0]!.source };
  }
  const rows = new Map(comparisons.map(comparison => {
    const scopeId = buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
    return [buildScmReviewedMarksKey(scopeId), { value: { v: 1, scopeId, reviewedChangeKeys: [`old-key-${comparison.id}`] }, version: 1 }] as const;
  }));
  let reads = 0; let writes = 0; let deletions = 0;
  let failCleanup = false; let offline = false; let cancelled = false; let cancelAfterDeletion = false;
  let inventoryReads = 0; let inventoryUnavailable = false;
  const portFor = (comparison: typeof comparisons[number]) => {
    const key = buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source }));
    return createScmReviewedMarksRecordPort({ comparison, transport: {
      read: async () => { reads++; return rows.get(key)!; },
      compareAndSet: async (value, version) => {
        writes++;
        if (failCleanup) throw new Error('Account KV unavailable');
        const row = rows.get(key)!;
        expect(version).toBe(row.version);
        // Opaque JSON persistence is the substituted boundary; real scope/CAS intent stays intact.
        rows.set(key, { value: value as typeof row.value, version: version + 1 });
        return { success: true, version: version + 1 };
      },
    } });
  };
  const input = { results: ['deleted', 'refused'].map(resultId => ({ cwd: '/repo', resultId,
    expectedRevision: 1, comparisonId: results.get(resultId)!.output.comparison!.id })) };
  const execute = (selected = input) => executeScmDiffSummaryClear({ input: selected,
    list: async () => { inventoryReads++; return inventoryUnavailable
      ? { success: false, errorCode: 'result_unavailable', error: 'Machine inventory unavailable' }
      : { success: true, results: [...results.values()].map(result => ({ cwd: '/repo', resultId: result.resultId,
      revision: result.revision, comparisonId: result.output.comparison!.id, source: result.output.comparison!.source,
      bytes: 1, updatedAtMs: 1 })), count: results.size, bytes: results.size }; },
    assertCurrent: () => { if (cancelled) throw new Error('Cancelled'); },
    read: async item => {
      if (offline) throw new Error('Machine offline');
      return { success: true, result: results.get(item.resultId)! };
    },
    delete: async item => {
      if (item.resultId === 'refused') return { success: false, errorCode: 'revision_conflict', latestRevision: 2, error: 'A concurrent edit won' };
      const result = results.get(item.resultId)!;
      results.delete(item.resultId); deletions++;
      if (cancelAfterDeletion) cancelled = true;
      return { success: true, resultId: item.resultId, comparisonId: result.output.comparison!.id };
    },
    clearReviewedMarks: (comparison, reset) => {
      expect(reset).toMatchObject({ comparisonId: comparison.id, cwd: comparison.repository.rootPath, source: comparison.source, reset: true });
      return portFor(comparison).clear();
    },
  });
  return { execute, input, rows, results, portFor, comparisons,
    inventoryReads: () => inventoryReads, failInventory: () => { inventoryUnavailable = true; },
    setOffline: () => { offline = true; }, setCleanupFailure: (value: boolean) => { failCleanup = value; },
    cancelAfterDeletion: () => { cancelAfterDeletion = true; }, counts: () => ({ reads, writes, deletions }) };
}

describe('canonical saved-result Clear and personal marks', () => {
  it.each(['refused', 'unselected'] as const)('preserves comparison marks while a %s saved result survives on this Machine', async survivor => {
    const f = fixture(survivor);
    expect(await f.execute()).toMatchObject({ success: true, deleted: [{ resultId: 'deleted' }] });
    expect(f.results.has(survivor)).toBe(true);
    expect([...f.rows.values()][0]!.value.reviewedChangeKeys).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 0, writes: 0, deletions: 1 });
  });
  it('cleans a shared comparison once after its last selected result is confirmed deleted', async () => {
    const f = fixture('unselected');
    expect(await f.execute({ results: [f.input.results[0]!, { cwd: '/repo', resultId: 'unselected',
      expectedRevision: 1, comparisonId: f.comparisons[0]!.id }] })).toMatchObject({ success: true,
        deleted: [{ resultId: 'deleted' }, { resultId: 'unselected' }], failures: [] });
    expect([...f.rows.values()][0]!.value.reviewedChangeKeys).toEqual([]);
    expect(f.counts()).toEqual({ reads: 1, writes: 1, deletions: 2 });
    expect(f.inventoryReads()).toBe(1);
  });
  it('preserves marks when another captured revision survives in the same personal comparison scope', async () => {
    const f = fixture('unselected', true);
    expect(f.results.get('unselected')!.output.comparison!.id).not.toBe(f.comparisons[0]!.id);
    expect(await f.execute()).toMatchObject({ success: true, deleted: [{ resultId: 'deleted' }] });
    expect([...f.rows.values()][0]!.value.reviewedChangeKeys).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 0, writes: 0, deletions: 1 });
    expect(f.inventoryReads()).toBe(1);
  });
  it('does not delete results or touch Account marks when the owning Machine inventory cannot be read', async () => {
    const f = fixture(); f.failInventory();
    expect(await f.execute()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(f.counts()).toEqual({ reads: 0, writes: 0, deletions: 0 });
  });
  it('resets only confirmed deleted comparison scopes and preserves refused and unrelated marks', async () => {
    const f = fixture();
    expect(await f.execute()).toMatchObject({ success: true, deleted: [{ resultId: 'deleted' }],
      failures: [{ resultId: 'refused', errorCode: 'revision_conflict' }] });
    expect([...f.rows.values()].map(row => row.value.reviewedChangeKeys.length)).toEqual([0, 1, 1]);
    expect(f.results.has('deleted')).toBe(false);
    expect(f.results.has('refused')).toBe(true);
    expect(f.counts()).toEqual({ reads: 1, writes: 1, deletions: 1 });
  });
  it('does no Account reads or writes when the Machine is offline', async () => {
    const f = fixture(); f.setOffline();
    expect(await f.execute()).toMatchObject({ success: true, deleted: [], failures: [
      { resultId: 'deleted', errorCode: 'result_unavailable' }, { resultId: 'refused', errorCode: 'result_unavailable' },
    ] });
    expect(f.counts()).toEqual({ reads: 0, writes: 0, deletions: 0 });
  });
  it('retains deletion receipts on typed cleanup partial and provides existing scope Reset recovery', async () => {
    const f = fixture(); f.setCleanupFailure(true);
    const partial = ScmDiffSummaryResultClearResponseSchema.parse(await f.execute({ results: [f.input.results[0]!] }));
    expect(partial).toMatchObject({ success: true, deleted: [{ resultId: 'deleted' }], failures: [{
      errorCode: 'reviewed_marks_cleanup_failed', resultDeleted: true, resultId: 'deleted',
      retry: { actionId: 'scm.diffSummary.reviewed.unmark', input: { reset: true } },
    }] });
    f.setCleanupFailure(false);
    expect(await f.portFor(f.comparisons[0]!).clear()).toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
    expect(f.counts()).toEqual({ reads: 2, writes: 2, deletions: 1 });
  });
  it('does not lose the deletion receipt when cancellation retires cleanup after Machine confirmation', async () => {
    const f = fixture(); f.cancelAfterDeletion();
    expect(await f.execute({ results: [f.input.results[0]!] })).toMatchObject({ success: true,
      deleted: [{ resultId: 'deleted' }], failures: [{ errorCode: 'reviewed_marks_cleanup_failed', resultDeleted: true }] });
    expect(f.counts()).toEqual({ reads: 0, writes: 0, deletions: 1 });
  });
});
