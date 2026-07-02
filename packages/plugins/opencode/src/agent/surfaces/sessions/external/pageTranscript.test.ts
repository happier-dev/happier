import { describe, expect, it, vi } from 'vitest';

import { pageOpenCodeTranscript } from './pageTranscript.js';

const sessionMessagesList = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const dispose = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: async () => ({
    sessionMessagesList,
    dispose,
  }),
}));

describe('pageOpenCodeTranscript', () => {
  it('advances backward pagination across pages that contain only filtered OpenCode messages', async () => {
    sessionMessagesList
      .mockResolvedValueOnce([
        {
          info: { id: 'msg-visible', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'visible' }],
        },
        {
          info: { id: 'msg-hidden-1', role: 'assistant', summary: true, time: { created: 2 } },
          parts: [{ type: 'text', text: 'hidden summary one' }],
        },
        {
          info: { id: 'msg-hidden-2', role: 'assistant', summary: true, time: { created: 3 } },
          parts: [{ type: 'text', text: 'hidden summary two' }],
        },
      ])
      .mockResolvedValueOnce([
        {
          info: { id: 'msg-visible', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'visible' }],
        },
        {
          info: { id: 'msg-hidden-1', role: 'assistant', summary: true, time: { created: 2 } },
          parts: [{ type: 'text', text: 'hidden summary one' }],
        },
        {
          info: { id: 'msg-hidden-2', role: 'assistant', summary: true, time: { created: 3 } },
          parts: [{ type: 'text', text: 'hidden summary two' }],
        },
      ]);

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(second.items.map((item) => item.id)).toEqual(['msg-visible']);
    expect(second.hasMore).toBe(false);
  });
});
