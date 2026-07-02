import { describe, expect, it } from 'vitest';

import { buildMemorySummaryShardWindows } from './buildMemorySummaryShardWindows';

function createItem(seq: number, text: string) {
  return {
    sessionId: 'sess-1',
    id: `item-${seq}`,
    seq,
    createdAtMs: 1_000 + seq,
    role: seq % 2 === 0 ? ('assistant' as const) : ('user' as const),
    kind: seq % 2 === 0 ? ('assistant_message' as const) : ('user_message' as const),
    text,
    textChars: text.length,
  };
}

describe('buildMemorySummaryShardWindows', () => {
  it('honors minShardMessages before splitting on targetShardMessages', () => {
    const windows = buildMemorySummaryShardWindows({
      items: [
        createItem(1, 'message-1'),
        createItem(2, 'message-2'),
        createItem(3, 'message-3'),
        createItem(4, 'message-4'),
      ],
      targetShardMessages: 1,
      minShardMessages: 2,
      targetShardChars: 1_000,
      maxShardChars: 5_000,
    });

    expect(windows.map((window) => [window.seqFrom, window.seqTo])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('treats targetShardChars as a soft target and maxShardChars as a hard cap', () => {
    const windows = buildMemorySummaryShardWindows({
      items: [
        createItem(1, 'a'.repeat(60)),
        createItem(2, 'b'.repeat(60)),
        createItem(3, 'c'.repeat(60)),
      ],
      targetShardMessages: 10,
      minShardMessages: 2,
      targetShardChars: 100,
      maxShardChars: 200,
    });

    expect(windows.map((window) => [window.seqFrom, window.seqTo])).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });
});
