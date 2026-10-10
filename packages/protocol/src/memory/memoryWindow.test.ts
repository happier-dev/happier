import { describe, expect, it } from 'vitest';

import { MemoryWindowV1Schema, MemoryWindowRequestV1Schema } from './memoryWindow.js';

describe('memory_window.v1 schema', () => {
  it('rejects mixed native and Session window identities rather than admitting native fields through Session passthrough', () => {
    expect(MemoryWindowRequestV1Schema.safeParse({ sessionId: 'session', seqFrom: 1, seqTo: 2,
      source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
      sourceItemId: 'item' }).success).toBe(false);
  });
  it('validates native windows with opaque source locators', () => {
    const window = { v: 1, snippets: [], citations: [], externalSnippets: [{
      source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'pi-source', nativeSessionId: 'native' },
      sourceItemId: 'native-message', cursor: 'opaque', createdAtMs: 1, text: 'Native visible text',
    }] };
    expect(MemoryWindowV1Schema.safeParse(window).success).toBe(true);
    expect(MemoryWindowV1Schema.safeParse({ ...window, externalSnippets: [{ ...window.externalSnippets[0], seqFrom: 1 }] }).success).toBe(false);
  });
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
