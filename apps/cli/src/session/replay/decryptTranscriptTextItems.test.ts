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
