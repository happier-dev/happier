import { describe, expect, it, vi } from 'vitest';

import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';
import { createGeminiTurnMessageState } from './geminiTurnMessageState';

describe('createGeminiBackendMessageHandler (reasoning)', () => {
  it('streams thinking chunks through transcript-vNext instead of durable thinking rows', () => {
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
    const transcriptStream = {
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(),
    };

    const handler = createGeminiBackendMessageHandler({
      session: session as any,
      messageBuffer: messageBuffer as any,
      state,
      diffProcessor,
      transcriptStream: transcriptStream as any,
    });

    const text = '**Title**\n\nHello';
    handler({ type: 'event', name: 'thinking', payload: { text } } as any);
    handler({ type: 'status', status: 'idle' } as any);

    const calls = (session.sendAgentMessage as any).mock.calls as any[][];
    const toolCalls = calls.filter((c) => c?.[1]?.type === 'tool-call');
    expect(toolCalls).toEqual([]);

    const thinkingMessages = calls.filter((c) => c?.[1]?.type === 'thinking');
    expect(thinkingMessages).toEqual([]);
    expect(transcriptStream.appendThinkingDelta).toHaveBeenCalledWith(text);
  });

  it('flushes streamed thinking before forwarding a Gemini tool-call boundary', () => {
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
    const transcriptStream = {
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(),
    };

    const handler = createGeminiBackendMessageHandler({
      session: session as any,
      messageBuffer: messageBuffer as any,
      state,
      diffProcessor,
      transcriptStream: transcriptStream as any,
    });

    handler({ type: 'event', name: 'thinking', payload: { text: 'Investigating' } } as any);
    handler({ type: 'tool-call', toolName: 'glob', callId: 'call_1', args: { pattern: '*.ts' } } as any);

    expect(transcriptStream.flushAll).toHaveBeenCalledWith({ reason: 'tool-call-boundary' });
  });
});
