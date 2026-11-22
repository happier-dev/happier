import { describe, expect, it } from 'vitest';
import { listUnreviewedSessionChangedFilesV1 } from './reviewSessionCoverageV1.js';

const turn = (turnId: string, startSeqInclusive: number, endSeqInclusive: number) => ({ sessionId: 's1', turnId,
  seqRange: { startSeqInclusive, endSeqInclusive }, status: 'completed' as const, files: [], provider: 'p', derivedAt: 0 });
const file = (filePath: string, turns: string[]) => ({ filePath, turns });
const changeSet = { turns: [turn('t1', 1, 4), turn('t2', 5, 9), turn('t3', 10, 14)],
  files: [file('a.ts', ['t1']), file('b.ts', ['t1', 't3']), file('c.ts', ['t2'])] };
const review = (state: 'completed' | 'partial' | 'running', sourceSessionId: string | null, sourceSessionSeq: number | null) =>
  ({ state, sourceSessionId, sourceSessionSeq });

describe('listUnreviewedSessionChangedFilesV1', () => {
  it('leaves out files whose every turn ended before the latest completed Review of this Session started', () => {
    const reviews = [review('completed', 's1', 4), review('completed', 's1', 9), review('running', 's1', 14),
      review('completed', 'other', 20), review('partial', 's1', 14)];
    expect(listUnreviewedSessionChangedFilesV1({ sessionId: 's1', changeSet, reviews }).map(item => item.filePath)).toEqual(['b.ts']);
  });
  it('treats every changed file as unreviewed when no completed Review covered the Session', () => {
    expect(listUnreviewedSessionChangedFilesV1({ sessionId: 's1', changeSet, reviews: [review('running', 's1', 14)] })
      .map(item => item.filePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
  it('counts a turn still in progress at Review start as unreviewed', () => {
    expect(listUnreviewedSessionChangedFilesV1({ sessionId: 's1', changeSet, reviews: [review('completed', 's1', 7)] })
      .map(item => item.filePath)).toEqual(['b.ts', 'c.ts']);
  });
});
