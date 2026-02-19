import { describe, expect, it, vi } from 'vitest';

import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';
import { createGeminiTurnMessageState } from './geminiTurnMessageState';

describe('createGeminiBackendMessageHandler (reasoning)', () => {
  it('does not emit GeminiReasoning tool calls for thinking chunks (only ACP thinking)', () => {
    const state = createGeminiTurnMessageState();
    const session = {
      sendAgentMessage: vi.fn(),
      keepAlive: vi.fn(),
    };
    const messageBuffer = {
      addMessage: vi.fn(),
      updateLastMessage: vi.fn(),
    };

    const diffProcessor = {} as any;

    const handler = createGeminiBackendMessageHandler({
      session: session as any,
      messageBuffer: messageBuffer as any,
      state,
      diffProcessor,
    });

    const text = '**Title**\n\nHello';
    handler({ type: 'event', name: 'thinking', payload: { text } } as any);
    handler({ type: 'status', status: 'idle' } as any);

    const calls = (session.sendAgentMessage as any).mock.calls as any[][];
    const toolCalls = calls.filter((c) => c?.[1]?.type === 'tool-call');
    expect(toolCalls).toEqual([]);

    const thinkingMessages = calls.filter((c) => c?.[1]?.type === 'thinking');
    expect(thinkingMessages).toEqual([['gemini', { type: 'thinking', text }]]);
  });
});
