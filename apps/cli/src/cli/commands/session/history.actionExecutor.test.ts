import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session history (action executor)', () => {
  afterEach(() => {
    execute.mockReset();
    createCliActionExecutorFromCredentials.mockClear();
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
