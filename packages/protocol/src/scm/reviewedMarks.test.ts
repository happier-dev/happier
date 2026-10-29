import { describe, expect, it } from 'vitest';
import { classifyAccountJsonKvKey } from '../account/accountJsonKv.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { buildScmComparisonSourceKey, type ScmComparison } from './comparison.js';
import { buildReviewUnits, buildScmChangeKeys, buildScmReviewScopeId } from './comparisonOccurrences.js';
import { applyScmReviewedMarkIntent, buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, isScmSelectionReviewed,
  ScmReviewedMarksRecordSchema, ScmReviewedMarkInputSchema, type ScmReviewedMarksJsonTransport } from './reviewedMarks.js';

function capture(id: string, options: { text?: string; path?: string; line?: number; sessionId?: string; duplicate?: boolean } = {}): ScmComparison {
  const path = options.path ?? 'a.ts'; const line = options.line ?? 2;
  const hunk = (start: number) => `@@ -${start},3 +${start},3 @@\n context\n-before\n+${options.text ?? 'after'}\n tail\n`;
  return { id, source: { kind: 'session', sessionId: options.sessionId ?? 'session-a' }, repository: { rootPath: '/repo' },
    endpoints: { before: `before-${id}`, after: `after-${id}` }, inventory: { state: 'complete', reasons: [], files: [{
      path, changeKind: 'modified', binary: false, generated: false, lockfile: false,
      evidence: { state: 'available', unifiedDiff: hunk(line) + (options.duplicate ? hunk(line + 10) : '') },
      occurrences: Array.from({ length: options.duplicate ? 2 : 1 }, (_, position) => ({
        id: `${id}:${position}`, alias: `c${position}`, path, position,
        before: { startLine: line + position * 10, lineCount: 3 }, after: { startLine: line + position * 10, lineCount: 3 },
      })),
    }] } };
}
const comparison = capture('first');
const marked = () => applyScmReviewedMarkIntent(comparison, null, ['first:0'], true);

describe('scope personal marks owner', () => {
  it('retains PR content marks across endpoint and source Action witness refreshes', async () => {
    const pullRequest = (id: string): ScmComparison => ({ ...capture(id), source: { kind: 'pullRequest', locator: {
      providerId: 'github', repository: 'owner/repo', number: 42, baseOid: `base-${id}`, headOid: `head-${id}`,
      sourceAction: { action: { pluginId: 'happier.scm.github', localId: 'comparison' }, input: { headOid: `head-${id}` } },
    } } });
    const first = pullRequest('first');
    let value: unknown = null;
    const transport: ScmReviewedMarksJsonTransport = { read: async () => ({ value, version: value === null ? -1 : 1 }),
      compareAndSet: async next => { value = next; return { success: true, version: 1 }; } };
    await createScmReviewedMarksRecordPort({ comparison: first, transport }).setReviewed(['first:0'], true);
    const refreshed = pullRequest('refresh');
    expect(buildScmComparisonSourceKey({ cwd: '/repo', source: refreshed.source }))
      .not.toBe(buildScmComparisonSourceKey({ cwd: '/repo', source: first.source }));
    const read = await createScmReviewedMarksRecordPort({ comparison: refreshed, transport }).read();
    expect(isScmSelectionReviewed(read.record, refreshed, ['refresh:0'])).toBe(true);
    const source = refreshed.source;
    if (source.kind !== 'pullRequest') throw new Error('Expected a PR comparison');
    for (const locator of [{ ...source.locator, number: 43 },
      { ...source.locator, sourceAction: { action: { pluginId: 'happier.scm.github', localId: 'other' } } }]) {
      const other = { ...refreshed, source: { kind: 'pullRequest' as const, locator } };
      expect(isScmSelectionReviewed(read.record, other, ['refresh:0'])).toBe(false);
    }
  });
  it('retains reviewed content when a session comparison is recaptured with shifted lines', async () => {
    let value: unknown = null;
    const transport: ScmReviewedMarksJsonTransport = { read: async () => ({ value, version: value === null ? -1 : 1 }),
      compareAndSet: async next => { value = next; return { success: true, version: 1 }; } };
    await createScmReviewedMarksRecordPort({ comparison, transport }).setReviewed(['first:0'], true);
    const recaptured = capture('second', { line: 20 });
    const read = await createScmReviewedMarksRecordPort({ comparison: recaptured, transport }).read();
    expect(isScmSelectionReviewed(read.record, recaptured, ['second:0'])).toBe(true);
    expect(read.record).toMatchObject({ v: 1, scopeId: expect.any(String), reviewedChangeKeys: [expect.any(String)] });
    expect(read.record).not.toHaveProperty('comparisonId');
  });
  it('invalidates edited text and distinguishes paths and session scopes', () => {
    for (const changed of [capture('edited', { text: 'rewritten' }), capture('path', { path: 'other.ts' }), capture('session', { sessionId: 'session-b' })]) {
      expect(isScmSelectionReviewed(marked(), changed, [`${changed.id}:0`])).toBe(false);
    }
    expect(isScmSelectionReviewed(marked(), comparison, [])).toBe(false);
    const noFinalNewline = capture('no-final-newline');
    noFinalNewline.inventory.files[0]!.evidence = { state: 'available', unifiedDiff: '@@ -2 +2 @@\n-before\n+after\n\\ No newline at end of file\n' };
    expect(isScmSelectionReviewed(marked(), noFinalNewline, ['no-final-newline:0'])).toBe(false);
  });
  it('uses duplicate ordinals so the identical second run is independently reviewed', () => {
    const duplicate = capture('duplicate', { duplicate: true });
    const record = applyScmReviewedMarkIntent(duplicate, null, ['duplicate:1'], true);
    expect(isScmSelectionReviewed(record, duplicate, ['duplicate:0'])).toBe(false);
    expect(isScmSelectionReviewed(record, duplicate, ['duplicate:1'])).toBe(true);
    const shifted = capture('shifted', { duplicate: true, line: 30 });
    expect(isScmSelectionReviewed(record, shifted, ['shifted:1'])).toBe(true);
  });
  it('addresses individual runs while a Walkthrough occurrence requires every run', async () => {
    const multiple = capture('multiple');
    multiple.inventory.files[0]!.evidence = { state: 'available', unifiedDiff: '@@ -1,5 +1,5 @@\n-old\n+new\n middle\n-other\n+replacement\n tail\n last\n' };
    let value: unknown = null;
    const port = createScmReviewedMarksRecordPort({ comparison: multiple, transport: {
      read: async () => ({ value, version: value === null ? -1 : 1 }), compareAndSet: async next => { value = next; return { success: true, version: 1 }; },
    } });
    const keys = buildScmChangeKeys(multiple).get('multiple:0')!;
    expect(keys).toHaveLength(2);
    const first = await port.setReviewedKeys([keys[0]!], true);
    expect(first.success && isScmSelectionReviewed(first.record, multiple, ['multiple:0'])).toBe(false);
    const all = await port.setReviewed(['multiple:0'], true);
    expect(all.success && isScmSelectionReviewed(all.record, multiple, ['multiple:0'])).toBe(true);
  });
  it('uses the mode-admitted namespace and the same key for captured and displayed live evidence', async () => {
    const live = { repositoryRootPath: '/repo', source: { kind: 'workingTree' as const }, changeKeys: buildReviewUnits('a.ts', undefined, comparison.inventory.files[0]!.evidence.unifiedDiff!).map(unit => unit.key) };
    const scopeId = buildScmReviewScopeId(live);
    expect(classifyAccountJsonKvKey(buildScmReviewedMarksKey(scopeId))).toBe('workspace');
    expect(buildScmReviewedMarksKey(scopeId)).toMatch(/^workspace:scm-reviewed:scope:/);
    const port = createScmReviewedMarksRecordPort({ source: live, transport: {
      read: async () => ({ value: null, version: -1 }), compareAndSet: async () => ({ success: true, version: 1 }),
    } });
    expect(await port.setReviewedKeys(live.changeKeys, true)).toMatchObject({ success: true, record: { scopeId, reviewedChangeKeys: live.changeKeys } });
    expect(() => port.setReviewedKeys(['unknown'], true)).toThrow();
  });
  it('admits closed live and captured key selectors without accepting mixed or fabricated comparison authority', () => {
    const live = { v: 2, cwd: '/repo', source: { kind: 'workingTree' }, changeKeys: ['key'] };
    expect(ScmReviewedMarkInputSchema.safeParse(live).success).toBe(true);
    expect(ScmReviewedMarkInputSchema.safeParse({ ...live, changeKeys: ['key', 'key'] }).success).toBe(false);
    expect(ScmReviewedMarkInputSchema.safeParse({ ...live, changeRefs: ['captured'] }).success).toBe(false);
    expect(ScmReviewedMarkInputSchema.safeParse({ ...live, comparisonId: 'a'.repeat(64) }).success).toBe(true);
    expect(ScmReviewedMarkInputSchema.safeParse({ ...live, comparisonId: 'a'.repeat(64), changeRefs: ['captured'] }).success).toBe(false);
    expect(ScmReviewedMarkInputSchema.safeParse({ ...live, comparison: {} }).success).toBe(false);
  });
  it('validates each intent against the latest displayed evidence without replacing the scope observer', async () => {
    let displayed = { repositoryRootPath: '/repo', source: { kind: 'workingTree' as const }, changeKeys: ['before-edit'] };
    let value: unknown = null;
    const port = createScmReviewedMarksRecordPort({ source: displayed, getSelection: () => ({ source: displayed }), transport: {
      read: async () => ({ value, version: value === null ? -1 : 1 }), compareAndSet: async next => { value = next; return { success: true, version: 1 }; },
    } });
    await port.setReviewedKeys(['before-edit'], true);
    displayed = { ...displayed, changeKeys: ['after-edit'] };
    expect(await port.setReviewedKeys(['after-edit'], true)).toMatchObject({ success: true, record: { reviewedChangeKeys: ['before-edit', 'after-edit'] } });
    expect(() => port.setReviewedKeys(['before-edit'], false)).toThrow();
    displayed = { ...displayed, repositoryRootPath: '/other' };
    expect(() => port.setReviewedKeys(['after-edit'], false)).toThrow();
  });
  it('admits an explicit scope reset only through unmark and never mixed with a selection', () => {
    const reset = { v: 2, cwd: '/repo', source: { kind: 'workingTree' }, reset: true };
    const unmark = getActionSpec('scm.diffSummary.reviewed.unmark').inputSchema;
    expect(unmark.safeParse(reset).success).toBe(true);
    expect(unmark.safeParse({ ...reset, source: { kind: 'session', sessionId: 'session-a' } }).success).toBe(false);
    expect(unmark.safeParse({ ...reset, comparisonId: 'a'.repeat(64), source: { kind: 'session', sessionId: 'session-a' } }).success).toBe(true);
    expect(unmark.safeParse({ ...reset, changeKeys: ['key'] }).success).toBe(false);
    expect(unmark.safeParse({ ...reset, changeRefs: ['ref'] }).success).toBe(false);
    expect(getActionSpec('scm.diffSummary.reviewed.mark').inputSchema.safeParse(reset).success).toBe(false);
  });
  it('drops stored extras and retains absent keys without pruning while keeping wire writes strict', async () => {
    const record = marked(); const stored = { ...record, reviewedChangeKeys: [...record.reviewedChangeKeys, 'absent-key'], future: { nested: true } };
    const writes: unknown[] = [];
    const port = createScmReviewedMarksRecordPort({ comparison, transport: {
      read: async () => ({ value: stored, version: 2 }), compareAndSet: async value => { writes.push(value); return { success: true, version: 3 }; },
    } });
    expect((await port.read()).record).toEqual({ ...record, reviewedChangeKeys: [...record.reviewedChangeKeys, 'absent-key'] });
    expect(await port.setReviewed(['first:0'], false)).toMatchObject({ success: true, record: { reviewedChangeKeys: ['absent-key'] } });
    expect(writes[0]).not.toHaveProperty('future');
    expect(ScmReviewedMarksRecordSchema.safeParse(stored).success).toBe(false);
  });
  it('rejects malformed records and refs outside the supplied evidence', () => {
    const record = marked();
    for (const value of [{ ...record, scopeId: 'other' }, { ...record, reviewedChangeKeys: ['same', 'same'] }, false]) {
      expect(() => applyScmReviewedMarkIntent(comparison, value, ['first:0'], true)).toThrow();
    }
    for (const refs of [['c0'], ['unknown'], ['first:0', 'first:0']]) expect(() => applyScmReviewedMarkIntent(comparison, null, refs, true)).toThrow();
  });
  it('rebases an unmark once over a concurrent unrelated key', async () => {
    const record = marked(); const winner = { ...record, reviewedChangeKeys: [...record.reviewedChangeKeys, 'unrelated-key'] };
    const writes: unknown[] = [];
    const port = createScmReviewedMarksRecordPort({ comparison, transport: { read: async () => ({ value: record, version: 2 }),
      compareAndSet: async (value, version) => { writes.push({ value, version }); return version === 2 ? { success: false, value: winner, version: 3 } : { success: true, version: 4 }; },
    } });
    expect(await port.setReviewed(['first:0'], false)).toEqual({ success: true, record: { ...record, reviewedChangeKeys: ['unrelated-key'] }, version: 4 });
    expect(writes).toHaveLength(2);
  });
  it('surfaces a second racing conflict without replaying indefinitely', async () => {
    let writes = 0; const record = { ...marked(), reviewedChangeKeys: ['other-key'] };
    const port = createScmReviewedMarksRecordPort({ comparison, transport: { read: async () => ({ value: null, version: -1 }),
      compareAndSet: async () => ({ success: false, value: record, version: ++writes }),
    } });
    expect(await port.setReviewed(['first:0'], true)).toMatchObject({ success: false, errorCode: 'reviewed_marks_conflict', record, version: 2 });
    expect(writes).toBe(2);
  });
  it('clears explicitly and preserves a concurrent tombstone version while rejecting stored JSON null', async () => {
    const record = marked(); const versions: number[] = [];
    const transport: ScmReviewedMarksJsonTransport = { read: async () => ({ value: record, version: 2 }),
      compareAndSet: async (_value, version) => { versions.push(version); return { success: false, value: null, version: 8, tombstone: true }; } };
    expect(await createScmReviewedMarksRecordPort({ comparison, transport }).clear()).toMatchObject({ success: true, version: 8 });
    expect(versions).toEqual([2]);
    await expect(createScmReviewedMarksRecordPort({ comparison, transport: { ...transport, read: async () => ({ value: null, version: 8 }) } }).read())
      .rejects.toMatchObject({ code: 'reviewed_marks_invalid_record' });
  });
});
