import { describe, expect, it } from 'vitest';

import { combinePermissionModeQueuedPrompts } from './queuedPrompt';

describe('combinePermissionModeQueuedPrompts', () => {
  it('joins prompt texts and keeps the first localId', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
    ]);
    expect(combined.text).toBe('one\ntwo');
    expect(combined.localId).toBe('a');
  });

  it('aggregates every localId in the batch for provider acceptance identity joins', () => {
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

  it('carries exact committed user-message seqs plus their batch max (HF-1 watermark custody)', () => {
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
