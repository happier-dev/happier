import { describe, expect, it } from 'vitest';

import { createOpenCodeTranscriptProjectionMapper } from '../../../runtime/server/transcript/indexedTranscript.js';
import { mapOpenCodeMessageToExternalSessionItem } from './messages.js';

describe('OpenCode external-session transcript messages', () => {
  it('maps current OpenCode server message info envelopes', () => {
    const user = mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-user',
        role: 'user',
        sessionID: 'sess-1',
        time: { created: 1_779_095_233_468 },
        model: { providerID: 'openai', modelID: 'gpt-5.4' },
      },
      parts: [{ type: 'text', text: 'hello from user', id: 'prt-user', sessionID: 'sess-1', messageID: 'msg-user' }],
    }, 'sess-1');
    const assistant = mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-assistant',
        parentID: 'msg-user',
        role: 'assistant',
        sessionID: 'sess-1',
        time: { created: 1_779_095_233_767, completed: 1_779_095_235_639 },
        providerID: 'openai',
        modelID: 'gpt-5.4',
      },
      parts: [{ type: 'text', text: 'hello from assistant', id: 'prt-assistant', sessionID: 'sess-1', messageID: 'msg-assistant' }],
    }, 'sess-1');

    expect(user).toMatchObject({
      id: 'opencode:sess-1:msg-user',
      localId: 'opencode:sess-1:msg-user',
      createdAtMs: 1_779_095_233_468,
      raw: {
        role: 'user',
        content: { type: 'text', text: 'hello from user' },
      },
    });
    expect(assistant).toMatchObject({
      id: 'opencode:sess-1:msg-assistant',
      localId: 'opencode:sess-1:msg-assistant',
      createdAtMs: 1_779_095_233_767,
      raw: {
        role: 'agent',
        content: { type: 'acp', agentId: 'opencode', data: { type: 'message', message: 'hello from assistant' } },
      },
    });
  });

  it('uses the shared OpenCode projection leaf to filter internal messages and project visible text', () => {
    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-compaction',
        role: 'assistant',
        summary: true,
        time: { created: 10 },
      },
      parts: [{ type: 'text', text: 'hidden summary' }],
    }, 'sess-1')).toBeNull();

    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-agent',
        role: 'assistant',
        time: { created: 20 },
      },
      parts: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'text', text: ' visible answer ' },
      ],
    }, 'sess-1')).toMatchObject({
      id: 'opencode:sess-1:msg-agent',
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'opencode',
          data: { type: 'message', message: 'visible answer' },
        },
      },
    });
  });

  it('projects step/text parts while excluding reasoning, tools, and unknown roles', () => {
    const item = mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-visible',
        role: 'assistant',
        time: { created: 1_779_095_233_468 },
      },
      parts: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'tool', text: 'hidden tool' },
        { type: 'step', text: 'visible step' },
        { type: 'text', text: ' visible text' },
      ],
    }, 'sess-1');

    expect(item?.raw).toMatchObject({
      role: 'agent',
      content: { type: 'acp', agentId: 'opencode', data: { type: 'message', message: 'visible step visible text' } },
    });

    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-system',
        role: 'system',
        time: { created: 1_779_095_233_468 },
      },
      parts: [{ type: 'text', text: 'system output' }],
    }, 'sess-1')).toBeNull();
  });

  it('omits transcript messages whose projected visible text is empty', () => {
    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-empty-content',
        role: 'assistant',
        time: { created: 1_779_095_233_468 },
      },
      content: '',
      parts: [{ type: 'text', text: 'fallback should not be skipped' }],
    }, 'sess-1')).toMatchObject({
      raw: {
        content: {
          data: { message: 'fallback should not be skipped' },
        },
      },
    });

    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-empty',
        role: 'assistant',
        time: { created: 1_779_095_233_468 },
      },
      parts: [{ type: 'reasoning', text: 'hidden only' }],
    }, 'sess-1')).toBeNull();
  });

  it('keeps plain external rows while allowing callers to suppress Happier-authored continuations', () => {
    const messages = [
      {
        info: { id: 'msg-user-external', role: 'user', time: { created: 10 } },
        parts: [{ type: 'text', text: 'external user' }],
      },
      {
        info: { id: 'msg-agent-external', role: 'assistant', time: { created: 20 } },
        parts: [{ type: 'text', text: 'external answer' }],
      },
      {
        info: { id: 'msg-user-happier', role: 'user', time: { created: 30 } },
        parts: [{ type: 'text', text: 'happier prompt' }],
      },
      {
        info: { id: 'msg-agent-late', role: 'assistant', time: { created: 40 } },
        parts: [{ type: 'text', text: 'late provider answer' }],
      },
    ];
    const mapper = createOpenCodeTranscriptProjectionMapper({
      messages,
      providerSessionId: 'sess-1',
      options: {
        isHappierAuthoredProviderUserMessageId: (messageId) => messageId === 'msg-user-happier',
      },
    });

    expect(messages.map((message, index) => mapper(message, index)?.id ?? null)).toEqual([
      'opencode:sess-1:msg-user-external',
      'opencode:sess-1:msg-agent-external',
      null,
      null,
    ]);
    expect(messages.map((message) => mapOpenCodeMessageToExternalSessionItem(message, 'sess-1')?.id ?? null)).toEqual([
      'opencode:sess-1:msg-user-external',
      'opencode:sess-1:msg-agent-external',
      'opencode:sess-1:msg-user-happier',
      'opencode:sess-1:msg-agent-late',
    ]);
  });
});
