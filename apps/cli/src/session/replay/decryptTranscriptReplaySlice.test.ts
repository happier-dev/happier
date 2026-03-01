import { describe, expect, it } from 'vitest';

import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';

describe('decryptTranscriptReplaySlice', () => {
  it('extracts latest session synopsis and excludes artifact rows from dialog', () => {
    const out = decryptTranscriptReplaySlice({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        },
        {
          seq: 2,
          createdAt: 2,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: {
                happier: {
                  kind: 'session_synopsis.v1',
                  payload: { v: 1, seqTo: 2, updatedAtMs: 5, synopsis: 'SYNOPSIS_OK' },
                },
              },
            },
          },
        },
        {
          seq: 3,
          createdAt: 3,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'reply' } } },
        },
      ],
    });

    expect(out.latestSynopsisText).toBe('SYNOPSIS_OK');
    expect(out.dialog.map((v) => v.text)).toEqual(['hello', 'reply']);
  });

  it('prefers the most recent synopsis by updatedAtMs', () => {
    const out = decryptTranscriptReplaySlice({
      rows: [
        {
          seq: 10,
          createdAt: 10,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: {
                happier: {
                  kind: 'session_synopsis.v1',
                  payload: { v: 1, seqTo: 10, updatedAtMs: 10, synopsis: 'OLD' },
                },
              },
            },
          },
        },
        {
          seq: 20,
          createdAt: 20,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: {
                happier: {
                  kind: 'session_synopsis.v1',
                  payload: { v: 1, seqTo: 20, updatedAtMs: 99, synopsis: 'NEW' },
                },
              },
            },
          },
        },
      ],
    });

    expect(out.latestSynopsisText).toBe('NEW');
    expect(out.dialog).toEqual([]);
  });
});
