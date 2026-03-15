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

