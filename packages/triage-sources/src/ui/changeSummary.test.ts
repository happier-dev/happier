import { describe, expect, it } from 'vitest';

import { summarizeTriageChangesV1 } from './changeSummary.js';

const file = (path: string, additions: number, deletions: number) => ({ path, lines: { additions, deletions } });

describe('the shared change summary of a change request', () => {
  it('draws the largest files first and counts the rest as smaller files', () => {
    const summary = summarizeTriageChangesV1({
      rows: [file('a', 1, 0), file('b', 90, 70), file('c', 40, 38), file('d', 5, 5), file('e', 52, 6)],
      more: false,
      shown: 3,
    });
    expect(summary.files.map((row) => row.path)).toEqual(['b', 'c', 'e']);
    expect(summary).toMatchObject({
      lines: { additions: 188, deletions: 119 }, fileCount: 5, complete: true, restCount: 2, sortedBySize: true, scale: 160,
    });
  });

  it('says the totals are partial while more pages remain unread', () => {
    const summary = summarizeTriageChangesV1({ rows: [file('a', 3, 1)], more: true, shown: 4 });
    expect(summary).toMatchObject({ lines: { additions: 3, deletions: 1 }, fileCount: 1, complete: false, restCount: 0 });
  });

  it('prefers the provider\'s own whole-change totals over the pages read', () => {
    const summary = summarizeTriageChangesV1({
      rows: [file('a', 3, 1), file('b', 1, 1)],
      more: true,
      shown: 1,
      totals: { files: 17, additions: 388, deletions: 142 },
    });
    // The rest counts every file the provider stated, not only the ones read.
    expect(summary).toMatchObject({ lines: { additions: 388, deletions: 142 }, fileCount: 17, complete: true, restCount: 16 });
  });

  it('states no line totals for a provider that reports none, and keeps its file order', () => {
    const summary = summarizeTriageChangesV1({
      rows: [{ path: 'z', note: 'edit' }, { path: 'a', note: 'add' }],
      more: false,
      shown: 4,
    });
    expect(summary).toMatchObject({ lines: null, fileCount: 2, complete: true, restCount: 0, sortedBySize: false });
    expect(summary.files.map((row) => row.path)).toEqual(['z', 'a']);
  });
});
