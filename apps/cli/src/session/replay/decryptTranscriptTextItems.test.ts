import { describe, expect, it } from 'vitest';

import { encodeBase64, encryptWithDataKey } from '@/api/encryption';

import { decryptTranscriptTextItems } from './decryptTranscriptTextItems';

function encryptedRow(params: { seq: number; createdAt: number; value: unknown }): any {
  const key = new Uint8Array(32).fill(9);
  const ciphertext = encodeBase64(encryptWithDataKey(params.value, key));
  return {
    key,
    row: {
      seq: params.seq,
      createdAt: params.createdAt,
      content: { t: 'encrypted', c: ciphertext },
    },
  };
}

describe('decryptTranscriptTextItems', () => {
  it('extracts assistant text from Claude output envelopes', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'output',
                data: {
                  type: 'assistant',
                  uuid: 'x',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(out).toEqual([{ role: 'Assistant', createdAt: 1, text: 'hi' }]);
  });

  it('extracts tool-use summaries from Claude output envelopes when no text is present', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'output',
                data: {
                  type: 'assistant',
                  uuid: 'x',
                  message: {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'Bash',
                        input: { command: 'ls -la', description: 'List files' },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ role: 'Assistant', createdAt: 1 });
    expect(String(out[0]?.text ?? '')).toContain('Bash');
    expect(String(out[0]?.text ?? '')).toContain('ls -la');
  });

  it('extracts tool-result summaries from Claude output envelopes', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'output',
                data: {
                  type: 'assistant',
                  uuid: 'x',
                  message: {
                    role: 'user',
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        content: 'OK',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ role: 'Assistant', createdAt: 1 });
    expect(String(out[0]?.text ?? '')).toContain('Tool result');
    expect(String(out[0]?.text ?? '')).toContain('OK');
  });

  it('extracts tool-call summaries from ACP envelopes (not only message text)', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: {
                  type: 'tool-call',
                  callId: 'acp_call_1',
                  name: 'Bash',
                  input: { command: 'pwd' },
                  id: 'acp-id-1',
                },
              },
            },
          },
        },
      ],
    });

    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ role: 'Assistant', createdAt: 1 });
    expect(String(out[0]?.text ?? '')).toContain('Tool use');
    expect(String(out[0]?.text ?? '')).toContain('Bash');
    expect(String(out[0]?.text ?? '')).toContain('pwd');
  });

  it('extracts tool-result summaries from ACP envelopes', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: {
                  type: 'tool-result',
                  callId: 'acp_call_1',
                  output: 'OK',
                  id: 'acp-id-2',
                },
              },
            },
          },
        },
      ],
    });

    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ role: 'Assistant', createdAt: 1 });
    expect(String(out[0]?.text ?? '')).toContain('Tool result');
    expect(String(out[0]?.text ?? '')).toContain('OK');
  });

  it('skips ACP thinking envelopes (replay seeds should not include internal reasoning)', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: { type: 'thinking', text: 'hmm' },
              },
            },
          },
        },
      ],
    });

    expect(out).toEqual([]);
  });

  it('skips ACP reasoning envelopes (replay seeds should not include chain-of-thought)', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                data: { type: 'reasoning', message: 'secret reasoning' },
              },
            },
          },
        },
      ],
    });

    expect(out).toEqual([]);
  });

  it('extracts assistant text and tool summaries from Codex envelopes', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: { type: 'message', message: 'hello' },
              },
            },
          },
        },
        {
          seq: 2,
          createdAt: 2,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: {
                  type: 'tool-call',
                  callId: 'codex_call_1',
                  name: 'Bash',
                  input: { command: 'pwd' },
                  id: 'codex-id-1',
                },
              },
            },
          },
        },
        {
          seq: 3,
          createdAt: 3,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'codex',
                data: {
                  type: 'tool-call-result',
                  callId: 'codex_call_1',
                  output: 'OK',
                  id: 'codex-id-2',
                },
              },
            },
          },
        },
      ],
    });

    expect(out.map((v) => v.text)).toHaveLength(3);
    expect(out[0]?.text).toBe('hello');
    expect(String(out[1]?.text ?? '')).toContain('Tool use');
    expect(String(out[1]?.text ?? '')).toContain('Bash');
    expect(String(out[1]?.text ?? '')).toContain('pwd');
    expect(String(out[2]?.text ?? '')).toContain('Tool result');
    expect(String(out[2]?.text ?? '')).toContain('OK');
  });

  it('accepts plaintext transcript rows without encryption materials (no decrypt)', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'aaa' } } },
        },
      ],
    });

    expect(out).toEqual([{ role: 'User', createdAt: 1, text: 'aaa' }]);
  });

  it('skips memory artifact transcript rows (session_synopsis.v1 + session_summary_shard.v1)', () => {
    const out = decryptTranscriptTextItems({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: 'S' } } },
            },
          },
        },
        {
          seq: 2,
          createdAt: 2,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: { happier: { kind: 'session_summary_shard.v1', payload: { v: 1, seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2, summary: 'S' } } },
            },
          },
        },
      ],
    });

    expect(out).toEqual([]);
  });

  it('sorts by seq when available (not createdAt)', () => {
    const a = encryptedRow({
      seq: 2,
      createdAt: 1,
      value: { role: 'agent', content: { type: 'text', text: 'bbb' } },
    });
    const b = encryptedRow({
      seq: 1,
      createdAt: 1,
      value: { role: 'user', content: { type: 'text', text: 'aaa' } },
    });

    const out = decryptTranscriptTextItems({
      rows: [a.row, b.row],
      encryptionKey: a.key,
      encryptionVariant: 'dataKey',
    });

    expect(out.map((v) => v.text)).toEqual(['aaa', 'bbb']);
  });

  it('truncates overly long text when maxTextChars is set', () => {
    const longText = 'x'.repeat(200);
    const a = encryptedRow({
      seq: 1,
      createdAt: 1,
      value: { role: 'user', content: { type: 'text', text: longText } },
    });

    const out = decryptTranscriptTextItems({
      rows: [a.row],
      encryptionKey: a.key,
      encryptionVariant: 'dataKey',
      maxTextChars: 40,
    });

    expect(out.length).toBe(1);
    expect(out[0]?.text.length).toBeLessThanOrEqual(40);
    expect(out[0]?.text.endsWith('...[truncated]')).toBe(true);
  });

  it('skips malformed encrypted rows instead of throwing', () => {
    const key = new Uint8Array(32).fill(9);

    expect(() => {
      decryptTranscriptTextItems({
        rows: [
          {
            seq: 1,
            createdAt: 1,
            content: {
              t: 'encrypted',
              get c() {
                throw new Error('boom');
              },
            },
          },
        ],
        encryptionKey: key,
        encryptionVariant: 'dataKey',
      });
    }).not.toThrow();
  });
});
