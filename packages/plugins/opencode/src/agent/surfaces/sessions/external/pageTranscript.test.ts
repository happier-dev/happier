import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pageOpenCodeTranscript } from './pageTranscript.js';

const sessionMessagesList = vi.hoisted(() => vi.fn());
const sessionGet = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: async () => ({
    sessionGet,
    sessionMessagesList,
    dispose,
  }),
}));

describe('pageOpenCodeTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionGet.mockResolvedValue({
      id: 'sess-1',
      time: { created: 100, updated: 100 },
    });
  });

  it('advances backward pagination across pages that contain only filtered OpenCode messages', async () => {
    sessionMessagesList
      .mockResolvedValueOnce({
        items: [
          {
          info: { id: 'msg-hidden-1', role: 'assistant', summary: true, time: { created: 2 } },
          parts: [{ type: 'text', text: 'hidden summary one' }],
          },
          {
          info: { id: 'msg-hidden-2', role: 'assistant', summary: true, time: { created: 3 } },
          parts: [{ type: 'text', text: 'hidden summary two' }],
          },
        ],
        nextCursor: 'official-before-cursor',
      })
      .mockResolvedValueOnce({
        items: [{
          info: { id: 'msg-visible', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'visible' }],
        }],
        nextCursor: null,
      });

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(second.items.map((item) => item.id)).toEqual(['opencode:sess-1:msg-visible']);
    expect(second.hasMore).toBe(false);
    expect(sessionMessagesList).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess-1',
      limit: 2,
    }));
    expect(sessionMessagesList).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess-1',
      limit: 2,
      before: 'official-before-cursor',
    }));
  });

  it('marks an oversized first visible item as truncated while advancing backward pagination', async () => {
    sessionMessagesList.mockResolvedValueOnce({
      items: [{
        info: { id: 'msg-long', role: 'assistant', time: { created: 1 } },
        parts: [{ type: 'text', text: 'x'.repeat(10_000) }],
      }],
      nextCursor: null,
    });

    const page = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 16,
      maxItems: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual(['opencode:sess-1:msg-long']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(true);
  });

  it('continues inside a bounded server page when the byte budget stops before older items', async () => {
    const boundedPage = {
      items: [
        {
          info: { id: 'msg-older', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'older' }],
        },
        {
          info: { id: 'msg-newer', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'newer' }],
        },
      ],
      nextCursor: null,
    };
    sessionMessagesList
      .mockResolvedValueOnce(boundedPage)
      .mockResolvedValueOnce({
        items: [boundedPage.items[1]],
        nextCursor: 'after-newer',
      })
      .mockResolvedValueOnce({
        items: [boundedPage.items[0]],
        nextCursor: null,
      });

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1,
      maxItems: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual(['opencode:sess-1:msg-newer']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.hasMore).toBe(true);
    expect(sessionMessagesList).toHaveBeenNthCalledWith(2, expect.objectContaining({
      limit: 1,
      sessionId: 'sess-1',
    }));

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 100_000,
      maxItems: 2,
    });
    expect(second.items.map((item) => item.id)).toEqual(['opencode:sess-1:msg-older']);
    expect(second.nextCursor).toBeNull();
    expect(sessionMessagesList).toHaveBeenNthCalledWith(3, expect.objectContaining({
      before: 'after-newer',
      limit: 2,
      sessionId: 'sess-1',
    }));
  });

  it('fences a backward-page continuation when OpenCode replaces the same session id', async () => {
    sessionGet
      .mockResolvedValueOnce({
        id: 'sess-1',
        time: { created: 100, updated: 100 },
      })
      .mockResolvedValueOnce({
        id: 'sess-1',
        time: { created: 100, updated: 101 },
      })
      .mockResolvedValueOnce({
        id: 'sess-1',
        time: { created: 200, updated: 200 },
      });
    sessionMessagesList
      .mockResolvedValueOnce({
        items: [{
          info: { id: 'msg-newer', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'newer source generation' }],
        }],
        nextCursor: 'official-before-cursor',
      })
      .mockResolvedValueOnce({
        items: [{
          info: { id: 'msg-replacement', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'replacement source generation' }],
        }],
        nextCursor: null,
      });

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 1,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const replacement = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 100_000,
      maxItems: 1,
    });

    expect(replacement).toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: true,
    });
    expect(sessionMessagesList).toHaveBeenCalledTimes(1);
  });

  it('applies zero page items when the source generation changes during the read', async () => {
    sessionGet
      .mockResolvedValueOnce({
        id: 'sess-1',
        time: { created: 100, updated: 100 },
      })
      .mockResolvedValueOnce({
        id: 'sess-1',
        time: { created: 200, updated: 200 },
      });
    sessionMessagesList.mockResolvedValueOnce({
      items: [{
        info: { id: 'msg-untrusted', role: 'assistant', time: { created: 2 } },
        parts: [{ type: 'text', text: 'must not escape the changed generation' }],
      }],
      nextCursor: null,
    });

    await expect(pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 1,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: true,
    });
  });

  it('rejects an unbound vendor cursor before reading the source', async () => {
    await expect(pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      direction: 'older',
      cursor: 'official-before-cursor',
      maxBytes: 100_000,
      maxItems: 1,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: true,
    });
    expect(sessionGet).not.toHaveBeenCalled();
    expect(sessionMessagesList).not.toHaveBeenCalled();
  });
});
