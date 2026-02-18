import { describe, expect, it } from 'vitest';

import { MessageAdapter } from './MessageAdapter';

describe('MessageAdapter (tool-result isError passthrough)', () => {
  it('includes toolIsError when provided', () => {
    const adapter = new MessageAdapter({ agentType: 'pi' as any });
    const msg = adapter.toMobile({
      type: 'tool-result',
      toolName: 'bash',
      callId: 'call_1',
      result: { content: 'nope' },
      isError: true,
    } as any);

    expect(msg.content.data).toMatchObject({
      type: 'tool-result',
      toolName: 'bash',
      toolCallId: 'call_1',
      toolIsError: true,
    });
  });
});

