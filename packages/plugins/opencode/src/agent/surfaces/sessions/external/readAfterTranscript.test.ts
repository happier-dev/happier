import { describe, expect, it, vi } from 'vitest';

import {
  encodeOpenCodeExternalAfterCursor,
  readAfterOpenCodeTranscript,
} from './readAfterTranscript.js';

const sessionMessagesList = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const dispose = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: async () => ({
    sessionMessagesList,
    dispose,
  }),
}));

describe('readAfterOpenCodeTranscript', () => {
  it('advances the cursor across filtered OpenCode internal messages', async () => {
    sessionMessagesList.mockResolvedValueOnce([
      {
        info: { id: 'msg-user', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'hello' }],
      },
      {
        info: { id: 'msg-compaction', role: 'assistant', summary: true, time: { created: 2 } },
        parts: [{ type: 'text', text: 'hidden summary' }],
      },
      {
        info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
        parts: [{ type: 'text', text: 'visible answer' }],
      },
    ]);

    const result = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: 0 }),
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(result.items.map((item) => item.id)).toEqual(['msg-user', 'msg-agent']);
    expect(result.nextCursor).toBe(encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: 3 }));
    expect(result.truncated).toBe(false);
  });
});
