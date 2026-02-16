import { describe, expect, it } from 'vitest';

import { MemoryWindowV1Schema } from './memoryWindow.js';

describe('memory_window.v1 schema', () => {
  it('parses window snippets and citations', () => {
    const parsed = MemoryWindowV1Schema.parse({
      v: 1,
      snippets: [
        {
          sessionId: 'sess_1',
          seqFrom: 10,
          seqTo: 15,
          createdAtFromMs: 1000,
          createdAtToMs: 2000,
          text: 'We talked about OpenClaw memory.',
        },
      ],
      citations: [{ sessionId: 'sess_1', seqFrom: 10, seqTo: 15 }],
    });
    expect(parsed.snippets).toHaveLength(1);
    expect(parsed.citations[0]?.sessionId).toBe('sess_1');
  });
});

