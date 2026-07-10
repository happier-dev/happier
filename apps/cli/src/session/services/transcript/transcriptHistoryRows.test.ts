import { describe, expect, it } from 'vitest';

import { extractCompactRow, normalizeTranscriptHistoryResult } from './transcriptHistoryRows';

describe('extractCompactRow', () => {
  it('extracts assistant text from output rows', () => {
    const row = extractCompactRow({
      createdAt: 1,
      fallbackId: '3',
      decrypted: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'OK' }],
            },
          },
        },
      },
    });

    expect(row).toMatchObject({
      id: '3',
      createdAt: 1,
      role: 'agent',
      kind: 'output',
      text: 'OK',
    });
  });

  it('extracts provider text from ACP message rows', () => {
    const row = extractCompactRow({
      createdAt: 1,
      fallbackId: '4',
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'opencode',
          data: {
            type: 'message',
            message: 'provider compact text',
          },
        },
      },
    });

    expect(row).toMatchObject({
      id: '4',
      createdAt: 1,
      role: 'agent',
      kind: 'acp',
      text: 'provider compact text',
    });
  });

  it('extracts assistant text from agent_message body rows', () => {
    const row = extractCompactRow({
      createdAt: 1,
      fallbackId: '5',
      decrypted: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'agent_message',
            text: 'codex compact text',
          },
        },
      },
    });

    expect(row).toMatchObject({
      id: '5',
      createdAt: 1,
      role: 'agent',
      kind: 'codex',
      text: 'codex compact text',
    });
  });
});

describe('normalizeTranscriptHistoryResult', () => {
  it('preserves seq on compact and raw rows so transcript consumers can order by durable sequence', () => {
    const payload = {
      sessionId: 'session-1',
      items: [
        {
          id: 'tool-row',
          seq: 42,
          createdAt: 20,
          raw: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'opencode',
              data: {
                type: 'tool-call',
                callId: 'tool-1',
                name: 'Bash',
                input: {},
              },
            },
          },
        },
        {
          id: 'user-row',
          seq: 41,
          createdAt: 21,
          raw: {
            role: 'user',
            content: {
              type: 'text',
              text: 'run pwd',
            },
          },
        },
      ],
    };

    expect(normalizeTranscriptHistoryResult(payload, 'compact', {
      includeMeta: false,
      includeStructuredPayload: false,
    }).messages).toEqual([
      expect.objectContaining({ id: 'tool-row', seq: 42 }),
      expect.objectContaining({ id: 'user-row', seq: 41 }),
    ]);

    expect(normalizeTranscriptHistoryResult(payload, 'raw', {
      includeMeta: false,
      includeStructuredPayload: false,
    }).messages).toEqual([
      expect.objectContaining({ id: 'tool-row', seq: 42 }),
      expect.objectContaining({ id: 'user-row', seq: 41 }),
    ]);
  });

  it('suppresses empty canonical turn diff tool-call/result pairs from action items', () => {
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

    const result = normalizeTranscriptHistoryResult({
      sessionId: 'session-1',
      items: [
        {
          id: 'call-row',
          createdAt: 10,
          raw: {
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
        {
          id: 'result-row',
          createdAt: 11,
          raw: {
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
      ],
    }, 'compact', {
      includeMeta: false,
      includeStructuredPayload: false,
    });

    expect(result).toEqual({
      sessionId: 'session-1',
      format: 'compact',
      messages: [],
    });
  });

  it('suppresses standalone empty v2 canonical Diff results from action items', () => {
    const result = normalizeTranscriptHistoryResult({
      sessionId: 'session-1',
      items: [
        {
          id: 'result-row',
          createdAt: 11,
          raw: {
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
      ],
    }, 'compact', {
      includeMeta: false,
      includeStructuredPayload: false,
    });

    expect(result).toEqual({
      sessionId: 'session-1',
      format: 'compact',
      messages: [],
    });
  });

  it('preserves v2 canonical Diff results with file evidence', () => {
    const result = normalizeTranscriptHistoryResult({
      sessionId: 'session-1',
      items: [
        {
          id: 'result-row',
          createdAt: 11,
          raw: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'codex',
              data: {
                type: 'tool-result',
                callId: 'diff-real-1',
                output: {
                  status: 'completed',
                  files: [
                    {
                      file_path: 'src/app.ts',
                      unified_diff: '@@ -1 +1 @@\n-old\n+new',
                    },
                  ],
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
      ],
    }, 'compact', {
      includeMeta: false,
      includeStructuredPayload: false,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'result-row',
      role: 'agent',
      kind: 'acp',
    });
  });
});
