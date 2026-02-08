import { describe, expect, it } from 'vitest';

import type { SDKAssistantMessage } from '@/backends/claude/sdk';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { formatClaudeMessageForInk } from '@/ui/messageFormatterInk';

type PartialAssistantMessage = SDKAssistantMessage & { happierPartial: true };

function buildPartialAssistantMessage(content: SDKAssistantMessage['message']['content']): PartialAssistantMessage {
  return {
    type: 'assistant',
    happierPartial: true,
    message: {
      role: 'assistant',
      content,
    },
  };
}

describe('formatClaudeMessageForInk', () => {
  it('coalesces synthetic partial assistant updates into a single assistant buffer entry', () => {
    const buffer = new MessageBuffer();

    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: 'Hel' }]),
      buffer,
    );
    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: 'lo' }]),
      buffer,
    );

    const assistantMessages = buffer.getMessages().filter((message) => message.type === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe('Hello');
  });

  it('starts a new assistant buffer entry when the last message is not assistant', () => {
    const buffer = new MessageBuffer();

    buffer.addMessage('Previous', 'assistant');
    buffer.addMessage('User asks', 'user');

    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: 'Hel' }]),
      buffer,
    );
    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: 'lo' }]),
      buffer,
    );

    const assistantMessages = buffer.getMessages().filter((message) => message.type === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content).toBe('Previous');
    expect(assistantMessages[1]?.content).toBe('Hello');
  });

  it('ignores empty/non-text partial segments', () => {
    const buffer = new MessageBuffer();

    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'tool_use', name: 'grep' }]),
      buffer,
    );
    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: '' }]),
      buffer,
    );
    formatClaudeMessageForInk(
      buildPartialAssistantMessage([{ type: 'text', text: 'Hello' }]),
      buffer,
    );

    const assistantMessages = buffer.getMessages().filter((message) => message.type === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe('Hello');
  });
});
