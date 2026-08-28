import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@happier-dev/cli-common/output';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { cmdSessionHistory } from './history';
import { handleSessionCommand } from './handleSessionCommand';

const { execute, createCliActionExecutorFromCredentials } = vi.hoisted(() => {
  const execute = vi.fn();
  return {
    execute,
    createCliActionExecutorFromCredentials: vi.fn(() => ({ execute })),
  };
});

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session history (action executor)', () => {
  afterEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
  });

  it('rejects --follow with --json before reading transcript history', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--follow', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({
        ok: false,
        kind: 'session_history',
        error: expect.objectContaining({ code: 'invalid_arguments' }),
      }));
    } finally {
      output.restore();
    }
  });

  it.each([
    ['--tail', ['history', 'sess-1', '--follow', '--tail', '10', '--jsonl']],
    ['--tail=10', ['history', 'sess-1', '--follow', '--tail=10', '--jsonl']],
    ['--limit', ['history', 'sess-1', '--follow', '--limit', '10', '--jsonl']],
    ['--limit=10', ['history', 'sess-1', '--follow', '--limit=10', '--jsonl']],
  ])('rejects %s with --follow before reading credentials or transcript actions', async (_flag, argv) => {
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('credentials must not be read for invalid arguments');
    });

    await expect(cmdSessionHistory(argv, { readCredentialsFn }))
      .rejects.toThrow(expect.objectContaining({
        code: 'invalid_arguments',
        message: '--tail and --limit are only supported for snapshot history.',
      }));

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('follows through finite transcript actions and emits normalized JSONL rows', async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, session: { id: 'sess-1', active: false } },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          leaseId: 'lease-1',
          items: [{
            id: 'row-1',
            seq: 1,
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: { role: 'agent', content: { type: 'text', text: 'final message' } },
          }],
          nextCursor: 'cursor-2',
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-2', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, released: true },
      });

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenNthCalledWith(
        1,
        'transcript.follow',
        expect.objectContaining({ sessionId: 'sess-1', cursor: 'tail' }),
        { surface: 'cli', defaultSessionId: null },
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'session.status.get',
        { sessionId: 'sess-1' },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(execute).toHaveBeenNthCalledWith(
        5,
        'transcript.unfollow',
        { sessionId: 'sess-1', leaseId: expect.any(String) },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.logs.map((line) => JSON.parse(line))).toEqual([
        {
          id: 'row-1',
          seq: 1,
          createdAt: 123,
          role: 'agent',
          kind: 'text',
          text: 'final message',
        },
      ]);
    } finally {
      output.restore();
    }
  });

  it('renders default follow messages through the compact human formatter', async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, session: { id: 'sess-1', active: false } },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          leaseId: 'lease-1',
          items: [{
            id: 'row-1',
            seq: 1,
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: { role: 'agent', content: { type: 'text', text: 'final message' } },
          }],
          nextCursor: 'cursor-2',
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-2', truncated: false },
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleText();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--follow'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.text()).toBe('agent: final message');
      expect(output.text()).not.toContain('"role"');
    } finally {
      output.restore();
    }
  });

  it('keeps explicit raw follow output as one JSON record', async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, session: { id: 'sess-1', active: false } },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ok: true,
          leaseId: 'lease-1',
          items: [{
            id: 'row-1',
            seq: 1,
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: { role: 'agent', content: { type: 'text', text: 'final message' } },
          }],
          nextCursor: 'cursor-2',
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, leaseId: 'lease-1', items: [], nextCursor: 'cursor-2', truncated: false },
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--follow', '--raw'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.logs).toHaveLength(1);
      expect(output.json()).toEqual(expect.objectContaining({
        id: 'row-1',
        role: 'agent',
        raw: { role: 'agent', content: { type: 'text', text: 'final message' } },
      }));
    } finally {
      output.restore();
    }
  });

  it('maps a follow failure to one JSONL family envelope and releases the lease once', async () => {
    execute
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'server_unreachable',
        error: 'daemon unavailable',
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, released: true } });

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['history', 'sess-1', '--follow', '--jsonl'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenNthCalledWith(
        2,
        'transcript.unfollow',
        { sessionId: 'sess-1', leaseId: expect.any(String) },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.logs.map((line) => JSON.parse(line))).toEqual([{
        v: 1,
        ok: false,
        kind: 'session_history',
        error: { code: 'server_unreachable', message: 'daemon unavailable' },
      }]);
    } finally {
      output.restore();
    }
  });

  it('routes through ActionExecutor and normalizes compact transcript items to legacy messages', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [
          {
            id: 'row-1',
            seq: 7,
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: {
              role: 'agent',
              content: { type: 'text', text: 'OK' },
              meta: { happier: { kind: 'review_findings.v1', payload: { count: 1 } } },
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--limit', '10', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.transcript.get',
        {
          sessionId: 'sess-1',
          limit: 10,
          scope: 'all',
          includeTools: true,
          includeReasoning: true,
          includeEvents: true,
          includeRaw: true,
          maxRawPayloadChars: 32768,
        },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: {
          sessionId: 'sess-1',
          format: 'compact',
          messages: [
            {
              id: 'row-1',
              seq: 7,
              createdAt: 123,
              role: 'agent',
              kind: 'text',
              text: 'OK',
              structuredKind: 'review_findings.v1',
            },
          ],
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('treats --tail as the user-facing synonym for --limit with identical JSON output', async () => {
    const result = {
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    };
    execute.mockResolvedValue(result);

    async function run(argv: string[]): Promise<string> {
      const output = captureConsoleJsonOutput();
      try {
        await cmdSessionHistory(argv, {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        });
        return output.logs.join('\n');
      } finally {
        output.restore();
      }
    }

    const limitOutput = await run(['history', 'sess-1', '--limit', '10', '--json']);
    const tailOutput = await run(['history', 'sess-1', '--tail', '10', '--json']);

    expect(tailOutput).toBe(limitOutput);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'session.transcript.get',
      expect.objectContaining({ sessionId: 'sess-1', limit: 10 }),
      { surface: 'cli', defaultSessionId: null },
    );
  });

  it.each([
    ['separate values', ['history', 'sess-1', '--tail', '10', '--limit', '20', '--json']],
    ['inline values', ['history', 'sess-1', '--tail=10', '--limit=20', '--json']],
  ])('rejects conflicting --tail and --limit %s before Action dispatch', async (_label, argv) => {
    await expect(cmdSessionHistory(argv, {
      readCredentialsFn: async () => ({
        token: 'token_test',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      }),
    })).rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('prints compact transcript lines and a concise count without dumping transcript JSON', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [{
          id: 'row-1',
          seq: 7,
          createdAt: 123,
          role: 'assistant',
          kind: 'assistant_message',
          raw: { role: 'agent', content: { type: 'text', text: 'OK' } },
        }],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const output = captureConsoleText();
    try {
      await cmdSessionHistory(['history', 'sess-1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.text()).toBe([
        'agent: OK',
        ok('History fetched (1 messages)'),
      ].join('\n'));
      expect(output.text()).not.toContain('"sessionId"');
      expect(output.text()).not.toContain('"messages"');
    } finally {
      output.restore();
    }
  });

  it('bounds each human compact row without truncating the JSON transcript', async () => {
    const runtimeContext = Array.from(
      { length: 80 },
      (_, index) => `RUNTIME_CONTEXT_LINE_${index + 1}`,
    ).join('\n');
    const singleLineContext = `${'SINGLE_LINE_CONTEXT_'.repeat(200)}RUNTIME_CONTEXT_TAIL`;
    const result = {
      ok: true,
      sessionId: 'sess-1',
      items: [
        {
          id: 'runtime-context',
          seq: 1,
          createdAt: 123,
          role: 'assistant',
          kind: 'assistant_message',
          raw: { role: 'agent', content: { type: 'text', text: runtimeContext } },
        },
        {
          id: 'single-line-context',
          seq: 2,
          createdAt: 124,
          role: 'assistant',
          kind: 'assistant_message',
          raw: { role: 'agent', content: { type: 'text', text: singleLineContext } },
        },
        {
          id: 'user-turn',
          seq: 3,
          createdAt: 125,
          role: 'user',
          kind: 'user_message',
          raw: { role: 'user', content: { type: 'text', text: 'actual user turn' } },
        },
        {
          id: 'assistant-turn',
          seq: 4,
          createdAt: 126,
          role: 'assistant',
          kind: 'assistant_message',
          raw: { role: 'agent', content: { type: 'text', text: 'actual assistant turn' } },
        },
      ],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 4, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
    };
    execute.mockResolvedValue({ ok: true, result });

    const textOutput = captureConsoleText();
    try {
      await cmdSessionHistory(['history', 'sess-1'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(textOutput.text()).toContain('… [truncated; use --json for full text]');
      expect(textOutput.text()).not.toContain('RUNTIME_CONTEXT_LINE_25');
      expect(textOutput.text()).not.toContain('RUNTIME_CONTEXT_TAIL');
      expect(textOutput.text()).toContain('user: actual user turn');
      expect(textOutput.text()).toContain('agent: actual assistant turn');
      expect(textOutput.text().split('\n')).toHaveLength(30);
    } finally {
      textOutput.restore();
    }

    const jsonOutput = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(jsonOutput.json()).toMatchObject({
        ok: true,
        kind: 'session_history',
        data: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ text: runtimeContext }),
            expect.objectContaining({ text: singleLineContext }),
          ]),
        }),
      });
    } finally {
      jsonOutput.restore();
    }
  });

  it('keeps provider payloads visible in --raw output without appending human prose', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [{
          id: 'row-1',
          seq: 7,
          createdAt: 123,
          role: 'assistant',
          kind: 'assistant_message',
          raw: {
            role: 'agent',
            content: { type: 'text', text: 'OK' },
            meta: { provider: { traceId: 'trace-1' } },
          },
        }],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const output = captureConsoleText();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--raw', '--include-meta'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.text()).toContain('"raw"');
      expect(output.text()).toContain('"traceId": "trace-1"');
      expect(output.text()).not.toContain('History fetched');
    } finally {
      output.restore();
    }
  });

  it.each([
    ['uses the default limit when --limit is omitted', ['history', 'sess-1', '--json'], 50],
    ['clamps an explicit limit to the supported action maximum', ['history', 'sess-1', '--limit', '999', '--json'], 100],
  ])('%s', async (_label, argv, expectedLimit) => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });
    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(argv, {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(execute).toHaveBeenLastCalledWith(
        'session.transcript.get',
        expect.objectContaining({ limit: expectedLimit }),
        { surface: 'cli', defaultSessionId: null },
      );
    } finally {
      output.restore();
    }
  });

  it('renders current native ACP text payloads as their semantic text in compact history', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [
          {
            id: 'row-native-text',
            seq: 2,
            createdAt: 123,
            storedMessageRole: 'unknown',
            semanticRole: 'assistant',
            role: 'assistant',
            kind: 'assistant_message',
            text: 'CODEX_LUNA_LOW_READY',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'agent',
                data: {
                  type: 'text',
                  text: 'CODEX_LUNA_LOW_READY',
                },
              },
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--format', 'compact', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: {
          sessionId: 'sess-1',
          format: 'compact',
          messages: [
            {
              id: 'row-native-text',
              seq: 2,
              createdAt: 123,
              role: 'agent',
              kind: 'acp',
              text: 'CODEX_LUNA_LOW_READY',
            },
          ],
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('normalizes raw transcript items to legacy messages', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [
          {
            id: 'row-1',
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: {
              role: 'agent',
              content: { type: 'text', text: 'OK' },
              meta: { happier: { kind: 'review_findings.v1', payload: { count: 1 } } },
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--limit', '10', '--format', 'raw', '--include-meta', '--include-structured-payload', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.transcript.get',
        {
          sessionId: 'sess-1',
          limit: 10,
          scope: 'all',
          includeTools: true,
          includeReasoning: true,
          includeEvents: true,
          includeRaw: true,
          maxRawPayloadChars: 32768,
          includeMeta: true,
          includeStructuredPayload: true,
        },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: {
          sessionId: 'sess-1',
          format: 'raw',
          messages: [
            {
              id: 'row-1',
              createdAt: 123,
              role: 'agent',
              raw: {
                role: 'agent',
                content: { type: 'text', text: 'OK' },
                meta: { happier: { kind: 'review_findings.v1', payload: { count: 1 } } },
              },
            },
          ],
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('accepts --raw as a raw history shorthand', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [
          {
            id: 'row-1',
            createdAt: 123,
            role: 'assistant',
            kind: 'assistant_message',
            raw: {
              role: 'agent',
              content: { type: 'text', text: 'OK' },
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--raw', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: {
          sessionId: 'sess-1',
          format: 'raw',
          messages: [
            {
              id: 'row-1',
              createdAt: 123,
              role: 'agent',
              raw: {
                role: 'agent',
                content: { type: 'text', text: 'OK' },
              },
            },
          ],
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects unsupported formats as invalid arguments before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionHistory } = await import('./history');

    await expect(cmdSessionHistory(
      ['history', 'sess-1', '--format', 'definitely-invalid'],
      { readCredentialsFn },
    )).rejects.toThrow('Invalid --format value "definitely-invalid". Expected one of: compact, raw.');

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses semantic summaries for compact raw-backed event-like transcript items', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-1',
        items: [
          {
            id: 'row-tool',
            createdAt: 456,
            storedMessageRole: 'event',
            semanticRole: 'tool',
            role: 'tool',
            kind: 'tool_call',
            provider: 'opencode',
            toolName: 'Diff',
            summary: 'Tool use (Diff): repository diff',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'opencode',
                data: {
                  type: 'tool-call',
                  name: 'Diff',
                  input: { description: 'repository diff' },
                },
              },
            },
          },
          {
            id: 'row-event',
            createdAt: 457,
            storedMessageRole: 'event',
            semanticRole: 'event',
            role: 'event',
            kind: 'turn_failed',
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'opencode',
                data: {
                  type: 'turn_failed',
                  id: 'turn-1',
                },
              },
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--limit', '10', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: {
          sessionId: 'sess-1',
          format: 'compact',
          messages: [
            {
              id: 'row-tool',
              createdAt: 456,
              role: 'tool',
              kind: 'tool_call',
              text: 'Tool use (Diff): repository diff',
            },
            {
              id: 'row-event',
              createdAt: 457,
              role: 'event',
              kind: 'turn_failed',
              text: '',
            },
          ],
        },
      }));
    } finally {
      output.restore();
    }
  });

  it('rejects an explicit invalid limit before reading credentials', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const { cmdSessionHistory } = await import('./history');

    await expect(cmdSessionHistory(['history', 'sess-1', '--limit', '0'], { readCredentialsFn }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('preserves approval request results before history normalization', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'artifact-1' },
    });

    const { cmdSessionHistory } = await import('./history');

    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionHistory(['history', 'sess-1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: { kind: 'approval_request_created', artifactId: 'artifact-1' },
      }));
    } finally {
      output.restore();
    }
  });
});
