import { describe, expect, it } from 'vitest';
import { addDiscardedCommittedMessageLocalIds } from './discardedCommittedMessageLocalIds';

describe('addDiscardedCommittedMessageLocalIds', () => {
  it('adds new ids and preserves existing entries', () => {
    const next = addDiscardedCommittedMessageLocalIds(
      { discardedCommittedMessageLocalIds: ['a'] },
      ['b', 'a', 'c'],
    );

    expect(next.discardedCommittedMessageLocalIds).toEqual(['a', 'b', 'c']);
  });

  it('retains historical discarded identities beyond the former eviction limit', () => {
    const historical = Array.from({ length: 501 }, (_, index) => `old-${index}`);
    const next = addDiscardedCommittedMessageLocalIds(
      { discardedCommittedMessageLocalIds: historical },
      ['c', 'd'],
    );

    expect(next.discardedCommittedMessageLocalIds).toEqual([...historical, 'c', 'd']);
  });
});

