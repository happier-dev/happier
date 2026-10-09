import { describe, expect, it } from 'vitest';
import { classifyAccountJsonKvKey } from '../account/accountJsonKv.js';
import type { ScmComparison } from './comparison.js';
import { applyScmReviewedMarkIntent, buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, isScmSelectionReviewed,
  ScmReviewedMarksRecordSchema, type ScmReviewedMarksJsonTransport } from './reviewedMarks.js';

const comparison: ScmComparison = { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
  endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [{
    path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: 'patch' }, occurrences: [0, 1, 2].map(position => ({
      id: `exact:${position}`, alias: `c${position}`, path: 'a.ts', position,
      before: { startLine: position, lineCount: 1 }, after: { startLine: position, lineCount: 1 },
    })),
  }] } };
const record = (...reviewedChangeRefs: string[]) => ({ v: 1 as const, comparisonId: comparison.id, reviewedChangeRefs });

describe('comparison personal marks owner', () => {
  it('clears the exact comparison record without needing saved code and rebases a concurrent mark once', async () => {
    const writes: unknown[] = [];
    const transport: ScmReviewedMarksJsonTransport = {
      read: async () => ({ value: record('exact:0'), version: 2 }),
      compareAndSet: async (value, version) => {
        writes.push({ value, version });
        return version === 2 ? { success: false, value: record('exact:0', 'other-preserved-until-clear'), version: 3 }
          : { success: true, version: 4 };
      },
    };
    const identityOnlyComparison = { ...comparison, inventory: { ...comparison.inventory, files: [] } };
    expect(await createScmReviewedMarksRecordPort({ comparison: identityOnlyComparison, transport }).clear())
      .toEqual({ success: true, record: record(), version: 4 });
    expect(writes).toEqual([{ value: record(), version: 2 }, { value: record(), version: 3 }]);
    const wrongRecord = { ...record('exact:0'), comparisonId: 'different-comparison' };
    await expect(createScmReviewedMarksRecordPort({ comparison: identityOnlyComparison, transport: {
      read: async () => ({ value: wrongRecord, version: 1 }), compareAndSet: transport.compareAndSet,
    } }).clear()).rejects.toMatchObject({ code: 'reviewed_marks_invalid_record' });
    expect(writes).toHaveLength(2);
  });
  it('uses the existing mode-admitted namespace and a distinct key per exact comparison', () => {
    expect(classifyAccountJsonKvKey(buildScmReviewedMarksKey(comparison.id))).toBe('workspace');
    expect(buildScmReviewedMarksKey('other')).not.toBe(buildScmReviewedMarksKey(comparison.id));
  });
  it('drops stored extras on read and emits canonical marks while keeping wire records strict', async () => {
    const writes: unknown[] = [];
    const port = createScmReviewedMarksRecordPort({ comparison, transport: {
      read: async () => ({ value: { ...record('exact:0'), future: { nested: true } }, version: 2 }),
      compareAndSet: async (value) => { writes.push(value); return { success: true, version: 3 }; },
    } });
    expect(await port.read()).toEqual({ record: record('exact:0'), version: 2 });
    expect(await port.setReviewed(['exact:1'], true)).toEqual({ success: true, record: record('exact:0', 'exact:1'), version: 3 });
    expect(writes).toEqual([record('exact:0', 'exact:1')]);
  });
  it('rejects malformed, duplicate or wrong-comparison persisted marks and unknown wire fields', () => {
    expect(ScmReviewedMarksRecordSchema.safeParse({ ...record(), unknown: true }).success).toBe(false);
    for (const value of [record('c0'), record('exact:0', 'exact:0'), { ...record(), comparisonId: 'other' }, { ...record(), reviewedChangeRefs: [1] }, false]) {
      expect(() => applyScmReviewedMarkIntent(comparison, value, ['exact:1'], true)).toThrow();
    }
  });
  it('reconciles an unmark intent with a concurrent unrelated mark and preserves both writers', async () => {
    const writes: unknown[] = [];
    const transport: ScmReviewedMarksJsonTransport = {
      read: async () => ({ value: record('exact:0'), version: 2 }),
      compareAndSet: async (value, version) => {
        writes.push({ value, version });
        return version === 2 ? { success: false, value: record('exact:0', 'exact:1'), version: 3 }
          : { success: true, version: 4 };
      },
    };
    await expect(createScmReviewedMarksRecordPort({ comparison, transport }).setReviewed(['exact:0'], false))
      .resolves.toEqual({ success: true, record: record('exact:1'), version: 4 });
    expect(writes).toEqual([{ value: record(), version: 2 }, { value: record('exact:1'), version: 3 }]);
  });
  it('surfaces a second racing conflict without looping or claiming the intent applied', async () => {
    let writes = 0;
    const transport: ScmReviewedMarksJsonTransport = {
      read: async () => ({ value: null, version: -1 }),
      compareAndSet: async () => ({ success: false, value: record('exact:1'), version: ++writes }),
    };
    await expect(createScmReviewedMarksRecordPort({ comparison, transport }).setReviewed(['exact:0'], true))
      .resolves.toMatchObject({ success: false, errorCode: 'reviewed_marks_conflict', record: record('exact:1'), version: 2 });
    expect(writes).toBe(2);
  });
  it('preserves a tombstone CAS version while rejecting stored JSON null', async () => {
    const versions: number[] = [];
    const transport: ScmReviewedMarksJsonTransport = {
      read: async () => ({ value: null, version: -1 }),
      compareAndSet: async (_value, version) => {
        versions.push(version);
        return version === -1 ? { success: false, value: null, version: 8, tombstone: true }
          : { success: true, version: 9 };
      },
    };
    await expect(createScmReviewedMarksRecordPort({ comparison, transport }).setReviewed(['exact:0'], true)).resolves.toMatchObject({ success: true, version: 9 });
    expect(versions).toEqual([-1, 8]);
    const malformed = createScmReviewedMarksRecordPort({ comparison, transport: { ...transport, read: async () => ({ value: null, version: 8 }) } });
    await expect(malformed.read()).rejects.toMatchObject({ code: 'reviewed_marks_invalid_record' });
  });
  it('derives merged-stop review status only from previously explicit membership', () => {
    const marked = applyScmReviewedMarkIntent(comparison, null, ['exact:0'], true);
    expect(isScmSelectionReviewed(marked, comparison.id, ['exact:0'])).toBe(true);
    expect(isScmSelectionReviewed(marked, comparison.id, ['exact:0', 'exact:1'])).toBe(false);
    expect(isScmSelectionReviewed(marked, 'refreshed', ['exact:0'])).toBe(false);
    expect(isScmSelectionReviewed(marked, comparison.id, [])).toBe(false);
    expect(() => applyScmReviewedMarkIntent({ ...comparison, id: 'refreshed' }, marked, ['exact:0'], true)).toThrow();
  });
});
