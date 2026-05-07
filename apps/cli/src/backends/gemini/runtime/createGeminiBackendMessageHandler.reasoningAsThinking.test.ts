import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';
import { createGeminiTurnMessageState } from './geminiTurnMessageState';

describe('createGeminiBackendMessageHandler (reasoning)', () => {
  it('tracks the current turn assistant preview from structured model output', () => {
    const state = createGeminiTurnMessageState();
    const tracker = createTurnAssistantPreviewTracker();
    const session = {
      sendAgentMessage: vi.fn(),
      keepAlive: vi.fn(),
    };
    const messageBuffer = {
      addMessage: vi.fn(),
      updateLastMessage: vi.fn(),
      removeLastMessage: vi.fn(),
    };

    const handler = createGeminiBackendMessageHandler({
      session: session as any,
      messageBuffer: messageBuffer as any,
      state,
      diffProcessor: {} as any,
      turnAssistantPreviewTracker: tracker,
    });

    handler({ type: 'model-output', textDelta: 'Hello' } as any);
    handler({ type: 'model-output', textDelta: ' world' } as any);

    expect(tracker.getPreview()).toBe('Hello world');
  });

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

  it('logs and swallows transcript flush failures at tool-call boundaries', async () => {
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
    const flushFailure = Promise.reject(new Error('flush failed'));
    flushFailure.catch(() => {});
    const transcriptStream = {
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(() => flushFailure),
    };
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    try {
      const handler = createGeminiBackendMessageHandler({
        session: session as any,
        messageBuffer: messageBuffer as any,
        state,
        diffProcessor,
        transcriptStream: transcriptStream as any,
      });

      handler({ type: 'tool-call', toolName: 'glob', callId: 'call_1', args: { pattern: '*.ts' } } as any);
      await Promise.resolve();

      expect(session.sendAgentMessage).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('[gemini] Failed to flush streamed thinking at tool-call boundary', expect.any(Error));
    } finally {
      debugSpy.mockRestore();
    }
  });
});
