import { describe, expect, it } from 'vitest';

import { extractOpenCodeTextHistoryItems } from './openCodeSessionMessageImport';

describe('extractOpenCodeTextHistoryItems', () => {
  it('extracts visible text and step parts without folding reasoning into the transcript text', () => {
    expect(
      extractOpenCodeTextHistoryItems([
        {
          info: { id: 'msg_1', role: 'assistant', time: { created: 123 } },
          parts: [
            { type: 'reasoning', text: 'internal reasoning' },
            {
              type: 'step',
              content: [{ type: 'text', text: 'visible step' }],
            },
            { type: 'text', text: 'final answer' },
          ],
        },
      ]),
    ).toEqual([
      {
        messageId: 'msg_1',
        role: 'assistant',
        createdAtMs: 123,
        text: 'visible stepfinal answer',
      },
    ]);
  });
});
