import { describe, expect, it } from 'vitest';

import { createOpenCodeTranscriptProjectionMapper } from '../../../runtime/server/transcript/indexedTranscript.js';
import {
  mapOpenCodeMessageToExternalSessionItems,
} from './messages.js';

function mapOpenCodeMessageToExternalSessionItem(message: unknown, providerSessionId: string) {
  return mapOpenCodeMessageToExternalSessionItems(message, providerSessionId).at(0) ?? null;
}

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
    // The server's external message DTO has a stable native id, but does not
    // carry the owned-runtime correlation needed to distinguish a terminal
    // user row from a Happier prompt echo.
    expect(user).not.toHaveProperty('userProjection');
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

  it('keeps reasoning hidden while faithfully projecting every supported tool call and result', () => {
    const items = mapOpenCodeMessageToExternalSessionItems({
      info: {
        id: 'msg-visible',
        role: 'assistant',
        time: { created: 1_779_095_233_468 },
      },
      parts: [
        { type: 'reasoning', text: 'hidden reasoning' },
        {
          id: 'part-read',
          type: 'tool',
          sessionID: 'sess-1',
          messageID: 'msg-visible',
          callID: 'call-read',
          tool: 'read',
          state: {
            status: 'completed',
            input: { path: 'README.md' },
            output: { text: 'contents' },
          },
        },
        {
          id: 'part-bash',
          type: 'tool',
          sessionID: 'sess-1',
          messageID: 'msg-visible',
          callID: 'call-bash',
          tool: 'bash',
          state: {
            status: 'error',
            input: { command: 'false' },
            output: 'command failed',
          },
        },
        { type: 'step', text: 'visible step' },
        { type: 'text', text: ' visible text' },
      ],
    }, 'sess-1');

    expect(items.map((item) => ({
      id: item.id,
      messageRole: item.messageRole,
      data: (item.raw.content as Readonly<{ data: unknown }>).data,
    }))).toEqual([
      {
        id: 'opencode:sess-1:msg-visible',
        messageRole: 'agent',
        data: { type: 'message', message: 'visible step visible text' },
      },
      {
        id: expect.stringMatching(/:tool-call:/u),
        messageRole: 'event',
        data: {
          type: 'tool-call',
          id: expect.stringMatching(/:tool-call:/u),
          callId: 'call-read',
          name: 'read',
          input: { path: 'README.md' },
        },
      },
      {
        id: expect.stringMatching(/:tool-result:/u),
        messageRole: 'event',
        data: {
          type: 'tool-result',
          id: expect.stringMatching(/:tool-result:/u),
          callId: 'call-read',
          output: { text: 'contents' },
        },
      },
      {
        id: expect.stringMatching(/:tool-call:/u),
        messageRole: 'event',
        data: {
          type: 'tool-call',
          id: expect.stringMatching(/:tool-call:/u),
          callId: 'call-bash',
          name: 'bash',
          input: { command: 'false' },
        },
      },
      {
        id: expect.stringMatching(/:tool-result:/u),
        messageRole: 'event',
        data: {
          type: 'tool-result',
          id: expect.stringMatching(/:tool-result:/u),
          callId: 'call-bash',
          output: 'command failed',
          isError: true,
        },
      },
    ]);
    expect(JSON.stringify(items)).not.toContain('hidden reasoning');

    expect(mapOpenCodeMessageToExternalSessionItem({
      info: {
        id: 'msg-system',
        role: 'system',
        time: { created: 1_779_095_233_468 },
      },
      parts: [{ type: 'text', text: 'system output' }],
    }, 'sess-1')).toBeNull();
  });

  it('keeps a nonterminal tool as a call until its source result exists', () => {
    const items = mapOpenCodeMessageToExternalSessionItems({
      info: { id: 'msg-running-tool', role: 'assistant', time: { created: 20 } },
      parts: [{
        type: 'tool',
        sessionID: 'sess-1',
        messageID: 'msg-running-tool',
        callID: 'call-running',
        tool: 'bash',
        state: { status: 'running', input: { command: 'pwd' } },
      }],
    }, 'sess-1');

    expect(items.map((item) => (item.raw.content as Readonly<{ data: unknown }>).data)).toEqual([
      {
        type: 'tool-call',
        id: expect.stringMatching(/:tool-call:/u),
        callId: 'call-running',
        name: 'bash',
        input: { command: 'pwd' },
      },
    ]);
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
