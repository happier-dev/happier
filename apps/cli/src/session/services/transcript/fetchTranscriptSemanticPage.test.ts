import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerDebug } = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebug,
  },
}));

import { fetchTranscriptSemanticPage, type FetchTranscriptRawPage } from './fetchTranscriptSemanticPage';

const ctx = { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' as const };

describe('fetchTranscriptSemanticPage', () => {
  beforeEach(() => {
    loggerDebug.mockReset();
  });

  it('resumes from the last consumed row when the semantic limit stops inside a raw page', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 10,
          createdAt: 100,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'first message' } },
          },
        },
        {
          seq: 9,
          createdAt: 90,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'second message' } },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 1,
      rawPageLimit: 20,
      maxRawRowsToScan: 20,
      direction: 'before',
      scope: 'main',
      serverRoles: ['user'],
      mode: 'transcript',
      transcriptRoles: ['user'],
      fetchPage,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: '10',
        role: 'user',
        text: 'first message',
      }),
    ]);
    expect(page.nextCursor).toBe('10');
    expect(page.hasMore).toBe(true);
  });

  it('logs safe scan budget telemetry without transcript content', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>()
      .mockResolvedValueOnce({
        messages: [
          {
            seq: 10,
            createdAt: 100,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'token_count' } } } },
          },
          {
            seq: 9,
            createdAt: 90,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'token_count' } } } },
          },
        ],
        hasMore: true,
        nextBeforeSeq: 8,
        nextAfterSeq: null,
      });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 1,
      rawPageLimit: 2,
      maxRawRowsToScan: 2,
      direction: 'before',
      scope: 'main',
      serverRoles: ['agent'],
      mode: 'transcript',
      transcriptRoles: ['assistant'],
      fetchPage,
    });

    expect(page.diagnostics.scanLimitReached).toBe(true);
    expect(loggerDebug).toHaveBeenCalledWith('session_transcript_scan_budget_exhausted', {
      direction: 'before',
      limit: 1,
      maxRawRowsToScan: 2,
      mode: 'transcript',
      pagesFetched: 1,
      rawRowsScanned: 2,
      scope: 'main',
      sessionId: 'session-1',
    });
  });

  it('logs safe raw payload truncation telemetry without transcript content', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 10,
          createdAt: 100,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: { type: 'tool-call', name: 'Bash', input: { command: 'secret'.repeat(100) } },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 1,
      rawPageLimit: 1,
      maxRawRowsToScan: 1,
      direction: 'before',
      scope: 'all',
      mode: 'events',
      includeRaw: true,
      maxPayloadChars: 32,
      fetchPage,
    });

    expect(page.diagnostics.payloadTruncations).toBe(1);
    expect(loggerDebug).toHaveBeenCalledWith('session_events_payload_truncated', {
      limit: 1,
      maxPayloadChars: 32,
      maxTotalPayloadBytes: 262144,
      mode: 'events',
      pagesFetched: 1,
      payloadTruncations: 1,
      rawRowsScanned: 1,
      sessionId: 'session-1',
    });
    const payload = loggerDebug.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('applies event kind filters before total raw payload budget truncation', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 10,
          createdAt: 100,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: { type: 'tool-call', name: 'Bash', input: { command: 'x'.repeat(200) } },
              },
            },
          },
        },
        {
          seq: 9,
          createdAt: 90,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'codex', data: { type: 'token_count' } },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 1,
      rawPageLimit: 2,
      maxRawRowsToScan: 2,
      direction: 'before',
      scope: 'all',
      mode: 'events',
      includeRaw: true,
      eventKinds: ['usage'],
      maxTotalPayloadBytes: 1,
      fetchPage,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: '9',
        kind: 'usage',
      }),
    ]);
  });

  it('suppresses empty canonical turn diff tool-call/result pairs', async () => {
    const turnDiffInput = {
      files: [],
      _happier: {
        sessionChangeScope: 'turn',
        turnId: 'turn-1',
        sessionId: 'session-1',
        provider: 'codex',
        source: 'scm_checkpoint',
        confidence: 'exact',
        turnStatus: 'completed',
        seqRange: {
          startSeqInclusive: 10,
          endSeqInclusive: 11,
        },
      },
    };
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 10,
          createdAt: 100,
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                  type: 'tool-call',
                  callId: 'diff-empty-1',
                  name: 'Diff',
                  input: JSON.stringify(turnDiffInput),
                },
              },
            },
          },
        },
        {
          seq: 11,
          createdAt: 101,
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                  type: 'tool-result',
                  callId: 'diff-empty-1',
                  output: JSON.stringify({ status: 'completed', files: [] }),
                },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 10,
      direction: 'before',
      scope: 'all',
      mode: 'transcript',
      includeTools: true,
      includeRaw: true,
      fetchPage,
    });

    expect(page.items).toEqual([]);
  });

  it('suppresses standalone empty canonical turn diff results when result metadata is present', async () => {
    const turnDiffResult = {
      status: 'completed',
      files: [],
      _happier: {
        sessionChangeScope: 'turn',
        turnId: 'turn-1',
        sessionId: 'session-1',
        provider: 'codex',
        source: 'scm_checkpoint',
        confidence: 'exact',
        turnStatus: 'completed',
        seqRange: {
          startSeqInclusive: 10,
          endSeqInclusive: 11,
        },
      },
    };
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 11,
          createdAt: 101,
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                  type: 'tool-result',
                  callId: 'diff-empty-1',
                  output: turnDiffResult,
                },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 10,
      direction: 'before',
      scope: 'all',
      mode: 'transcript',
      includeTools: true,
      includeRaw: true,
      fetchPage,
    });

    expect(page.items).toEqual([]);
  });

  it('suppresses standalone empty v2 canonical Diff results without evidence', async () => {
    const fetchPage = vi.fn<FetchTranscriptRawPage>().mockResolvedValueOnce({
      messages: [
        {
          seq: 11,
          createdAt: 101,
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                  type: 'tool-result',
                  callId: 'diff-empty-1',
                  output: {
                    status: 'completed',
                    _happier: {
                      v: 2,
                      protocol: 'acp',
                      provider: 'codex',
                      rawToolName: 'Diff',
                      canonicalToolName: 'Diff',
                    },
                    _raw: { status: 'completed' },
                    _acp: {},
                  },
                },
              },
            },
          },
        },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    const page = await fetchTranscriptSemanticPage({
      token: 'token',
      sessionId: 'session-1',
      ctx,
      limit: 10,
      rawPageLimit: 10,
      maxRawRowsToScan: 10,
      direction: 'before',
      scope: 'all',
      mode: 'transcript',
      includeTools: true,
      includeRaw: true,
      fetchPage,
    });

    expect(page.items).toEqual([]);
  });
});
