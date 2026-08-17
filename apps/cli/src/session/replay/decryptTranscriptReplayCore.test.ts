import { describe, expect, it } from 'vitest';

import { decryptTranscriptReplayCore } from './decryptTranscriptReplayCore';

describe('decryptTranscriptReplayCore', () => {
  it('respects an explicit maxDialogItems bound above 200', () => {
    const rows = Array.from({ length: 300 }, (_v, idx) => {
      const i = idx + 1;
      return {
        seq: i,
        createdAt: i,
        content: {
          t: 'plain',
          v: { role: 'user', content: { type: 'text', text: `msg${i}` } },
        },
      };
    });

    const res = decryptTranscriptReplayCore({ rows, maxDialogItems: 300 });
    expect(res.dialog).toHaveLength(300);
    expect(res.dialog[0]?.text).toBe('msg1');
    expect(res.dialog[299]?.text).toBe('msg300');
  });

  it('caps dialog to maxDialogItems by dropping the oldest items', () => {
    const rows = Array.from({ length: 300 }, (_v, idx) => {
      const i = idx + 1;
      return {
        seq: i,
        createdAt: i,
        content: {
          t: 'plain',
          v: { role: 'user', content: { type: 'text', text: `msg${i}` } },
        },
      };
    });

    const res = decryptTranscriptReplayCore({ rows, maxDialogItems: 200 });
    expect(res.dialog).toHaveLength(200);
    expect(res.dialog[0]?.text).toBe('msg101');
    expect(res.dialog[199]?.text).toBe('msg300');
  });
});


/**
 * The decoder is the ONLY owner that can tell an unreadable row from a row with
 * nothing to replay: every skip in its loop is a `continue`. Without this fact
 * the target Agent is handed a conversation with silent holes and told it is the
 * conversation.
 */
describe('decryptTranscriptReplayCore incompleteness', () => {
  const readableRow = (seq: number, text: string) => ({
    seq,
    createdAt: seq,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } },
  });

  it('reports examined rows it could not read', () => {
    const res = decryptTranscriptReplayCore({
      rows: [
        readableRow(1, 'hello'),
        // Sealed content with no key available to this decoder.
        { seq: 2, createdAt: 2, content: { t: 'encrypted', c: 'bm90LWRlY3J5cHRhYmxl' } },
        // Structurally unusable envelope.
        { seq: 3, createdAt: 3, content: { t: 'unknown-envelope' } },
      ],
    });

    expect(res.dialog.map((item) => item.text)).toEqual(['hello']);
    expect(res.unreadableRowCount).toBe(2);
  });

  it('does not count a readable row that simply carries nothing to replay', () => {
    const res = decryptTranscriptReplayCore({
      rows: [
        readableRow(1, 'hello'),
        { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } } },
      ],
    });

    expect(res.dialog.map((item) => item.text)).toEqual(['hello']);
    expect(res.unreadableRowCount).toBe(0);
  });
});
