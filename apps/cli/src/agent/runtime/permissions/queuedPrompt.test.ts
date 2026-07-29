import { describe, expect, it } from 'vitest';

import {
  combinePermissionModeQueuedPrompts,
  normalizePermissionModeQueuedPromptLocalIds,
} from './queuedPrompt';

describe('combinePermissionModeQueuedPrompts', () => {
  it('joins prompt texts and keeps the first localId', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
    ]);
    expect(combined.text).toBe('one\ntwo');
    expect(combined.localId).toBe('a');
  });

  it('aggregates every localId in an ordinary non-Pending batch', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
      { text: 'again', localId: 'a' },
      { text: 'anonymous', localId: null },
    ]);

    expect(combined).toMatchObject({
      localId: 'a',
      localIds: ['a', 'b'],
    });
  });

  it('preserves whitespace-distinct opaque local ids for exact provider outcome correlation', () => {
    expect(normalizePermissionModeQueuedPromptLocalIds({
      text: 'opaque ids',
      localId: ' local-id ',
      localIds: ['local-id', ' local-id ', '   '],
    })).toEqual([' local-id ', 'local-id']);
  });

  it('carries exact committed user-message seqs for host-consumed command replay suppression', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', userMessageSeq: 5 },
      { text: 'two', localId: 'b' },
      { text: 'three', localId: 'c', userMessageSeq: 9 },
    ]);
    expect(combined.userMessageSeq).toBe(9);
    expect(combined.userMessageSeqs).toEqual([5, 9]);
  });

  it('leaves userMessageSeq unset when no prompt in the batch carries one', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: null },
    ]);
    expect(combined.userMessageSeq ?? null).toBeNull();
  });
});
