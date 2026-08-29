import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeOpenCodeExternalAfterCursor,
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
        severity: 'benign',
        count: 1,
        positions: [1],
      },
      {
        code: 'unsupported_record_skipped',
        severity: 'required',
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

  it('walks one semantic item per call through a single OpenCode message with maxItems=1', async () => {
    sessionMessagesList.mockResolvedValue({
      items: [{
        info: { id: 'msg-1', role: 'assistant', time: { created: 1 } },
        parts: [
          { type: 'text', text: 'hello' },
          {
            id: 'part-1',
            type: 'tool',
            sessionID: 'sess-1',
            messageID: 'msg-1',
            callID: 'call-1',
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

    const read = (cursor: string) => readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor,
      maxBytes: 100_000,
      maxItems: 1,
    });

    // One native message expands to text + tool-call + tool-result; each bounded
    // call must advance exactly one semantic item inside that exact message.
    const first = await read(encodeOpenCodeExternalAfterCursor({
      v: 3,
      kind: 'opencodeAfter',
      messageId: null,
      sessionCreatedAtMs: 100,
    }));
    expect(first.outcome).toBe('advanced');
    if (first.outcome !== 'advanced') throw new Error('Expected advanced OpenCode text item');
    expect(first.items.map((item) => item.id)).toEqual(['opencode:sess-1:msg-1']);
    expect(decodeOpenCodeExternalAfterCursor(first.nextCursor)).toEqual({
      v: 3,
      kind: 'opencodeAfter',
      messageId: 'msg-1',
      sessionCreatedAtMs: 100,
      subIndex: 1,
    });

    const second = await read(first.nextCursor);
    expect(second.outcome).toBe('advanced');
    if (second.outcome !== 'advanced') throw new Error('Expected advanced OpenCode tool call');
    expect(second.items.map((item) => item.id)).toEqual([
      'opencode:sess-1:msg-1:tool-call:call-1',
    ]);
    expect(decodeOpenCodeExternalAfterCursor(second.nextCursor)).toEqual({
      v: 3,
      kind: 'opencodeAfter',
      messageId: 'msg-1',
      sessionCreatedAtMs: 100,
      subIndex: 2,
    });

    const third = await read(second.nextCursor);
    expect(third.outcome).toBe('advanced');
    if (third.outcome !== 'advanced') throw new Error('Expected advanced OpenCode tool result');
    expect(third.items.map((item) => item.id)).toEqual([
      'opencode:sess-1:msg-1:tool-result:call-1',
    ]);
    // The message is exhausted, so the cursor returns to the legacy whole-message
    // anchor shape.
    expect(decodeOpenCodeExternalAfterCursor(third.nextCursor)).toEqual({
      v: 3,
      kind: 'opencodeAfter',
      messageId: 'msg-1',
      sessionCreatedAtMs: 100,
      subIndex: 0,
    });

    await expect(read(third.nextCursor)).resolves.toEqual({ outcome: 'already_current' });
  });

  it('continues across a multi-item message boundary in order without duplicates or loss', async () => {
    sessionMessagesList.mockResolvedValue({
      items: [
        {
          info: { id: 'msg-1', role: 'assistant', time: { created: 1 } },
          parts: [
            { type: 'text', text: 'hello' },
            {
              id: 'part-1',
              type: 'tool',
              sessionID: 'sess-1',
              messageID: 'msg-1',
              callID: 'call-1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: '/repo\\n',
              },
            },
          ],
        },
        {
          info: { id: 'msg-2', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'answer' }],
        },
      ],
      nextCursor: null,
    });

    const read = (cursor: string) => readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4099' },
      providerSessionId: 'sess-1',
      cursor,
      maxBytes: 100_000,
      maxItems: 2,
    });

    const first = await read(encodeOpenCodeExternalAfterCursor({
      v: 3,
      kind: 'opencodeAfter',
      messageId: null,
      sessionCreatedAtMs: 100,
    }));
    expect(first.outcome).toBe('advanced');
    if (first.outcome !== 'advanced') throw new Error('Expected advanced first page');
    expect(first.items.map((item) => item.id)).toEqual([
      'opencode:sess-1:msg-1',
      'opencode:sess-1:msg-1:tool-call:call-1',
    ]);
    expect(decodeOpenCodeExternalAfterCursor(first.nextCursor)).toMatchObject({
      messageId: 'msg-1',
      subIndex: 2,
    });

    // The continuation resumes inside msg-1 and crosses into msg-2 without
    // repeating the served tool call or dropping the tool result.
    const second = await read(first.nextCursor);
    expect(second.outcome).toBe('advanced');
    if (second.outcome !== 'advanced') throw new Error('Expected advanced second page');
    expect(second.items.map((item) => item.id)).toEqual([
      'opencode:sess-1:msg-1:tool-result:call-1',
      'opencode:sess-1:msg-2',
    ]);
    expect(second.hasMore).toBe(false);
    expect(decodeOpenCodeExternalAfterCursor(second.nextCursor)).toEqual({
      v: 3,
      kind: 'opencodeAfter',
      messageId: 'msg-2',
      sessionCreatedAtMs: 100,
      subIndex: 0,
    });

    await expect(read(second.nextCursor)).resolves.toEqual({ outcome: 'already_current' });
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
