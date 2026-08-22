import { describe, expect, it } from 'vitest';

import {
  REPLAY_CORPUS_DATA_KEY,
  createMalformedCiphertextRow,
  createMixedAgentReplayCorpus,
  createUndecryptableRow,
} from '@/testkit/transcript/replayTranscriptCorpora';

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

  it('keeps media references only from dialog rows retained for replay', () => {
    const retainedPath = '.happier/uploads/messages/session-1/message-2/retained.png';
    const omittedPath = '.happier/uploads/messages/session-1/message-1/omitted.png';
    const media = (path: string) => ({
      kind: 'session_media.v1',
      payload: { media: [{ category: 'attachment', path }] },
    });

    const res = decryptTranscriptReplayCore({
      maxDialogItems: 1,
      rows: [
        {
          seq: 1,
          createdAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'omitted transcript row' },
              meta: { happier: media(omittedPath) },
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
              content: { type: 'text', text: 'retained transcript row' },
              meta: { happier: media(retainedPath) },
            },
          },
        },
      ],
    });

    expect(res.dialog.map((item) => item.text)).toEqual(['retained transcript row']);
    expect(res.referencedSessionMediaWorkspacePaths).toEqual([retainedPath]);
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
      { role: 'Assistant', createdAt: 1, seq: 1, text: 'codex replay text' },
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
      { role: 'User', createdAt: 2, seq: 2, text: 'same words' },
    ]);
  });

  it('keeps both Agents’ history and never replays the transition divider prose', () => {
    const corpus = createMixedAgentReplayCorpus();

    const res = decryptTranscriptReplayCore({ rows: corpus.rows });

    expect(res.dialog.map((item) => item.text)).toEqual([
      ...corpus.sourceAgentTexts,
      ...corpus.targetAgentTexts,
    ]);
    expect(res.dialog.some((item) => item.text.includes(corpus.dividerMessage))).toBe(false);
  });

  it('keeps decodable history when an examined row cannot be decrypted', () => {
    const corpus = createMixedAgentReplayCorpus({ encrypted: true });
    const rows = [...corpus.rows, createUndecryptableRow({ seq: 30 })];

    const res = decryptTranscriptReplayCore({
      rows,
      encryptionKey: REPLAY_CORPUS_DATA_KEY,
      encryptionVariant: 'dataKey',
    });

    expect(res.dialog.map((item) => item.text)).toEqual([
      ...corpus.sourceAgentTexts,
      ...corpus.targetAgentTexts,
    ]);
  });

  /**
   * The decoder is the ONLY owner that can tell an unreadable row from a row with
   * nothing to replay: every skip below it is a `continue`. Without this fact the
   * target Agent is handed a conversation with silent holes and told it is the
   * conversation.
   */
  describe('incompleteness', () => {
    it('reports how many examined rows could not be read', () => {
      const corpus = createMixedAgentReplayCorpus({ encrypted: true });
      const rows = [
        ...corpus.rows,
        createUndecryptableRow({ seq: 30 }),
        createMalformedCiphertextRow({ seq: 31 }),
      ];

      const res = decryptTranscriptReplayCore({
        rows,
        encryptionKey: REPLAY_CORPUS_DATA_KEY,
        encryptionVariant: 'dataKey',
      });

      expect(res.unreadableRowCount).toBe(2);
    });

    it('reports encrypted rows it has no key for as unreadable', () => {
      const corpus = createMixedAgentReplayCorpus({ encrypted: true });

      const encryptedRowCount = corpus.rows.filter(
        (row) => (row.content as { t?: unknown }).t === 'encrypted',
      ).length;

      const res = decryptTranscriptReplayCore({ rows: corpus.rows });

      expect(encryptedRowCount).toBeGreaterThan(0);
      expect(res.dialog).toEqual([]);
      expect(res.unreadableRowCount).toBe(encryptedRowCount);
    });

    it('does not count a readable row that simply carries nothing to replay', () => {
      const res = decryptTranscriptReplayCore({
        rows: [
          { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } } },
          { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', meta: { isThinking: true }, content: { type: 'text', text: 'thinking' } } } },
        ],
      });

      expect(res.dialog.map((item) => item.text)).toEqual(['hello']);
      expect(res.unreadableRowCount).toBe(0);
    });
  });
});
