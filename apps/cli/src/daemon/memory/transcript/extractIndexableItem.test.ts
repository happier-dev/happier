import { describe, expect, it } from 'vitest';

import { extractMemoryIndexableTranscriptItem } from './extractIndexableItem';

const ctx = { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' as const };

describe('extractMemoryIndexableTranscriptItem', () => {
  it('converts semantic user and provider assistant messages into indexable memory items', () => {
    const user = extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row: {
        id: 'row-user',
        seq: 1,
        createdAt: 1000,
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'remember the orchard plan' } } },
      },
      index: 0,
      ctx,
    });
    const assistant = extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row: {
        id: 'row-assistant',
        seq: 2,
        createdAt: 1001,
        messageRole: 'agent',
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'codex', provider: 'codex', data: { type: 'message', message: 'the orchard plan is saved' } },
          },
        },
      },
      index: 1,
      ctx,
    });

    expect(user).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      id: 'row-user',
      seq: 1,
      createdAtMs: 1000,
      role: 'user',
      kind: 'user_message',
      text: 'remember the orchard plan',
      textChars: 25,
      sourceStoredMessageRole: 'user',
    }));
    expect(assistant).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      id: 'row-assistant',
      seq: 2,
      role: 'assistant',
      kind: 'assistant_message',
      provider: 'codex',
      text: 'the orchard plan is saved',
      sourceStoredMessageRole: 'agent',
    }));
  });

  it('excludes realtime conversation finals from coding-model memory', () => {
    const item = extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row: {
        id: 'voice-user-final',
        seq: 3,
        createdAt: 1002,
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'spoken orchard question' },
            meta: {
              happier: {
                kind: 'conversation_turn.v1',
                payload: { v: 1 },
                conversationTurnOriginV1: {
                  v: 1,
                  channel: 'realtime_conversation',
                  modality: 'voice',
                },
              },
            },
          },
        },
      },
      index: 0,
      ctx,
    });

    expect(item).toBeNull();
  });

  it('fails closed for malformed explicit provenance while preserving explicit Agent text', () => {
    const extract = (conversationTurnOriginV1: unknown) => extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row: {
        id: 'provenance-user',
        seq: 4,
        createdAt: 1003,
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'ordinary coding request' },
            meta: {
              happier: {
                kind: 'conversation_turn.v1',
                payload: { v: 1 },
                conversationTurnOriginV1,
              },
            },
          },
        },
      },
      index: 0,
      ctx,
    });

    expect(extract({
      v: 1,
      channel: 'realtime_conversation',
      modality: 'text',
    })).toBeNull();
    expect(extract({
      v: 1,
      channel: 'agent_thread',
      modality: 'text',
    })).toEqual(expect.objectContaining({
      id: 'provenance-user',
      role: 'user',
      text: 'ordinary coding request',
    }));
  });

  it('excludes tool details, events, memory artifacts, and reasoning by default', () => {
    const rows = [
      { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', input: { command: 'echo secret' } } } } } },
      { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'token_count' } } } } },
      { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: '[memory]' }, meta: { happier: { kind: 'session_summary_shard.v1', payload: {} } } } } },
      { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'private chain' } } } } },
    ];

    const items = rows.map((row, index) => extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row,
      index,
      ctx,
    }));

    expect(items).toEqual([null, null, null, null]);
  });

  it('keeps tool summary indexing generic when explicitly enabled', () => {
    const toolCall = extractMemoryIndexableTranscriptItem({
      sessionId: 'sess-1',
      row: {
        seq: 5,
        createdAt: 5,
        messageRole: 'agent',
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call',
                name: 'Bash',
                input: { command: `printf '${'x'.repeat(1000)}'` },
              },
            },
          },
        },
      },
      index: 0,
      ctx,
      contentPolicy: { includeToolSummaries: true },
    });

    expect(toolCall).toEqual(expect.objectContaining({
      kind: 'tool_summary',
      role: 'assistant',
      text: 'Tool use (Bash)',
    }));
    expect(toolCall!.text).not.toContain('printf');
    expect(toolCall!.text).not.toContain('x'.repeat(20));
  });
});
