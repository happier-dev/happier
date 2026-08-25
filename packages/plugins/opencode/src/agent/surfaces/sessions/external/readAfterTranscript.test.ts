import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeOpenCodeExternalAfterCursor,
  readAfterOpenCodeTranscript,
} from './readAfterTranscript.js';

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

describe('readAfterOpenCodeTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionGet.mockResolvedValue({
      id: 'sess-1',
      time: { created: 100, updated: 100 },
    });
  });

  it('advances the cursor across filtered OpenCode internal messages', async () => {
    sessionMessagesList.mockResolvedValueOnce({
      items: [{
        info: { id: 'msg-user', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'hello' }],
      },
      {
        info: { id: 'msg-compaction', role: 'assistant', summary: true, time: { created: 2 } },
        parts: [{ type: 'text', text: 'hidden summary' }],
      },
      {
        info: { id: 'msg-unknown', role: 'system', time: { created: 2 } },
        parts: [{ type: 'text', text: 'future server record' }],
      },
      {
        info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
        parts: [{ type: 'text', text: 'visible answer' }],
      }],
      nextCursor: null,
    });

    const result = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: null,
        sessionCreatedAtMs: 100,
      }),
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(result.outcome).toBe('advanced');
    if (result.outcome !== 'advanced') throw new Error('Expected an advanced result');
    expect(result.items.map((item) => item.id)).toEqual([
      'opencode:sess-1:msg-user',
      'opencode:sess-1:msg-agent',
    ]);
    expect(result.nextCursor).toBe(encodeOpenCodeExternalAfterCursor({
      v: 3,
      kind: 'opencodeAfter',
      messageId: 'msg-agent',
      sessionCreatedAtMs: 100,
    }));
    expect(result.diagnostics).toEqual([
      {
        code: 'non_transcript_record_skipped',
        count: 1,
        positions: [1],
      },
      {
        code: 'unsupported_record_skipped',
        count: 1,
        positions: [2],
      },
    ]);
    expect(sessionMessagesList).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      limit: 11,
    }));
  });

  it('advances through every supported tool call and terminal result without exposing reasoning', async () => {
    sessionMessagesList.mockResolvedValueOnce({
      items: [{
        info: { id: 'msg-tools', role: 'assistant', time: { created: 1 } },
        parts: [
          { type: 'reasoning', text: 'do not disclose this' },
          {
            id: 'part-tools',
            type: 'tool',
            sessionID: 'sess-1',
            messageID: 'msg-tools',
            callID: 'call-tools',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: '/repo\\n',
            },
          },
        ],
      }],
      nextCursor: null,
    });

    const result = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: null,
        sessionCreatedAtMs: 100,
      }),
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(result).toMatchObject({ outcome: 'advanced' });
    if (result.outcome !== 'advanced') throw new Error('Expected advanced OpenCode tools');
    expect(result.items.map((item) => (item.raw.content as Readonly<{ data: unknown }>).data)).toEqual([
      {
        type: 'tool-call',
        id: expect.stringMatching(/:tool-call:/u),
        callId: 'call-tools',
        name: 'bash',
        input: { command: 'pwd' },
      },
      {
        type: 'tool-result',
        id: expect.stringMatching(/:tool-result:/u),
        callId: 'call-tools',
        output: '/repo\\n',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('do not disclose this');
  });

  it.each([
    {
      name: 'known internal',
      message: {
        info: { role: 'assistant', summary: true, time: { created: 2 } },
        parts: [{ type: 'text', text: 'idless internal summary' }],
      },
    },
    {
      name: 'unknown',
      message: {
        info: { role: 'system', time: { created: 2 } },
        parts: [{ type: 'text', text: 'idless future record' }],
      },
    },
  ])('fails closed when an idless $name message prevents cursor advancement', async ({ message }) => {
    sessionMessagesList.mockResolvedValueOnce({
      items: [message],
      nextCursor: null,
    });

    await expect(readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: null,
        sessionCreatedAtMs: 100,
      }),
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({ outcome: 'gap_or_cursor_expired' });
  });

  it('reports a gap when OpenCode replaces a session while reusing its id and message ids', async () => {
    sessionGet.mockResolvedValueOnce({ id: 'sess-1', time: { created: 200, updated: 201 } });

    await expect(readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: 'msg-shared',
        sessionCreatedAtMs: 100,
      }),
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({ outcome: 'source_replaced' });
    expect(sessionMessagesList).not.toHaveBeenCalled();
  });

  it('reports a gap when the vendor session generation changes during the bounded read', async () => {
    sessionGet
      .mockResolvedValueOnce({ id: 'sess-1', time: { created: 100, updated: 101 } })
      .mockResolvedValueOnce({ id: 'sess-1', time: { created: 200, updated: 201 } });
    sessionMessagesList.mockResolvedValueOnce({
      items: [
        {
          info: { id: 'msg-shared', role: 'assistant', time: { created: 10 } },
          parts: [{ type: 'text', text: 'old boundary' }],
        },
        {
          info: { id: 'msg-new', role: 'assistant', time: { created: 20 } },
          parts: [{ type: 'text', text: 'untrusted after replacement' }],
        },
      ],
      nextCursor: null,
    });

    await expect(readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: 'msg-shared',
        sessionCreatedAtMs: 100,
      }),
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({ outcome: 'source_replaced' });
  });

  it('expires legacy message-only cursors instead of treating them as generation proof', async () => {
    const legacyCursor = Buffer.from(JSON.stringify({
      v: 2,
      kind: 'opencodeAfter',
      messageId: 'msg-shared',
    }), 'utf8').toString('base64url');

    await expect(readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor: legacyCursor,
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({ outcome: 'gap_or_cursor_expired' });
    expect(sessionGet).not.toHaveBeenCalled();
    expect(sessionMessagesList).not.toHaveBeenCalled();
  });
});
