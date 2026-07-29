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

  it('extracts assistant text from agent_message body rows', () => {
    const res = decryptTranscriptReplayCore({
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
                data: {
                  type: 'agent_message',
                  text: 'codex replay text',
                },
              },
            },
          },
        },
      ],
    });

    expect(res.dialog).toEqual([
      { role: 'Assistant', createdAt: 1, text: 'codex replay text' },
    ]);
  });

  it('excludes realtime conversation rows from coding-model replay without text heuristics', () => {
    const realtimeOrigin = {
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'voice',
        },
      },
    };
    const res = decryptTranscriptReplayCore({
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'same words' },
              meta: realtimeOrigin,
            },
          },
        },
        {
          seq: 2,
          createdAt: 2,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'same words' },
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
              content: { type: 'text', text: 'voice response' },
              meta: realtimeOrigin,
            },
          },
        },
      ],
    });

    expect(res.dialog).toEqual([
      { role: 'User', createdAt: 2, text: 'same words' },
    ]);
  });
});
