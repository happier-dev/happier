import { describe, expect, it } from 'vitest';

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
    }, 0);
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
    }, 1);

    expect(user).toMatchObject({
      id: 'msg-user',
      localId: 'msg-user',
      createdAtMs: 1_779_095_233_468,
      raw: {
        role: 'user',
        content: { type: 'text', text: 'hello from user' },
      },
    });
    expect(assistant).toMatchObject({
      id: 'msg-assistant',
      localId: 'msg-assistant',
      createdAtMs: 1_779_095_233_767,
      raw: {
        role: 'agent',
        content: { type: 'acp', provider: 'opencode', data: { type: 'message', message: 'hello from assistant' } },
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
    }, 0)).toBeNull();

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
    }, 1)).toMatchObject({
      id: 'msg-agent',
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'opencode',
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
    }, 0);

    expect(item?.raw).toMatchObject({
      role: 'agent',
      content: { type: 'acp', provider: 'opencode', data: { type: 'message', message: 'visible step visible text' } },
    });

    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-system',
        role: 'system',
        time: { created: 1_779_095_233_468 },
      },
      parts: [{ type: 'text', text: 'system output' }],
    }, 1)).toBeNull();
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
    }, 0)).toMatchObject({
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
    }, 1)).toBeNull();
  });
});
