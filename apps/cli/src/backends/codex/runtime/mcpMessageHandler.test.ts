import { describe, expect, it, vi } from 'vitest';

import {
  createCodexMcpMessageHandler,
  forwardCodexErrorToUi,
  forwardCodexStatusToUi,
} from './mcpMessageHandler';

describe('forwardCodexStatusToUi', () => {
  it('writes to terminal buffer and session events', () => {
    const messageBuffer = { addMessage: vi.fn() };
    const session = { sendSessionEvent: vi.fn() };

    forwardCodexStatusToUi({
      messageBuffer,
      session,
      messageText: 'status',
    });

    expect(messageBuffer.addMessage).toHaveBeenCalledWith('status', 'status');
    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'status' });
  });
});

describe('forwardCodexErrorToUi', () => {
  it('uses generic error text when message is empty', () => {
    const messageBuffer = { addMessage: vi.fn() };
    const session = { sendSessionEvent: vi.fn() };

    forwardCodexErrorToUi({
      messageBuffer,
      session,
      errorText: '  ',
    });

    expect(messageBuffer.addMessage).toHaveBeenCalledWith('Codex error', 'status');
    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Codex error' });
  });

  it('prefixes non-empty messages', () => {
    const messageBuffer = { addMessage: vi.fn() };
    const session = { sendSessionEvent: vi.fn() };

    forwardCodexErrorToUi({
      messageBuffer,
      session,
      errorText: 'boom',
    });

    expect(messageBuffer.addMessage).toHaveBeenCalledWith('Codex error: boom', 'status');
    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Codex error: boom' });
  });
});

describe('createCodexMcpMessageHandler', () => {
  it('does not throw when receiving circular event payloads', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendTranscriptDraftDelta: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      keepAlive: vi.fn(),
    };
    const messageBuffer = { addMessage: vi.fn() };
    const logger = { debug: vi.fn() };
    const diffProcessor = { processDiff: vi.fn() };

    const handler = createCodexMcpMessageHandler({
      logger,
      session,
      messageBuffer,
      sendReady: vi.fn(),
      publishCodexThreadIdToMetadata: vi.fn(),
      diffProcessor,
      getCurrentTaskId: () => currentTaskId,
      setCurrentTaskId: (next: string | null) => {
        currentTaskId = next;
      },
      getThinking: () => thinking,
      setThinking: (next: boolean) => {
        thinking = next;
      },
    });

    const msg: Record<string, unknown> = { type: 'codex/event' };
    msg.self = msg;

    expect(() => handler(msg)).not.toThrow();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('tracks thinking state and emits ready on task completion', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const keepAlive = vi.fn();
    const sendReady = vi.fn();
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendTranscriptDraftDelta: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      keepAlive,
    };
    const messageBuffer = { addMessage: vi.fn() };
    const logger = { debug: vi.fn() };
    const diffProcessor = { processDiff: vi.fn() };

    const handler = createCodexMcpMessageHandler({
      logger,
      session,
      messageBuffer,
      sendReady,
      publishCodexThreadIdToMetadata: vi.fn(),
      diffProcessor,
      getCurrentTaskId: () => currentTaskId,
      setCurrentTaskId: (next: string | null) => {
        currentTaskId = next;
      },
      getThinking: () => thinking,
      setThinking: (next: boolean) => {
        thinking = next;
      },
    });

    handler({ type: 'task_started' });
    expect(thinking).toBe(true);
    expect(keepAlive).toHaveBeenCalledWith(true, 'remote');
    expect(sendReady).not.toHaveBeenCalled();

    handler({ type: 'task_complete' });
    expect(thinking).toBe(false);
    expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(sendReady).toHaveBeenCalledTimes(1);
  });

  it('streams agent_reasoning deltas as ACP thinking messages (not tool calls)', () => {
    const prevDraftFlush = process.env.HAPPIER_STREAM_DRAFT_FLUSH_MS;
    const prevCheckpointMs = process.env.HAPPIER_STREAM_CHECKPOINT_MS;
    const prevMinChars = process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS;
    process.env.HAPPIER_STREAM_DRAFT_FLUSH_MS = '0';
    process.env.HAPPIER_STREAM_CHECKPOINT_MS = '1000000';
    process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS = '1000000';

    try {
      let thinking = false;
      let currentTaskId: string | null = null;
      const keepAlive = vi.fn();
      const sendReady = vi.fn();
      const session = {
        sendAgentMessage: vi.fn(),
        sendAgentMessageCommitted: vi.fn(async () => {}),
        sendTranscriptDraftDelta: vi.fn(),
        sendCodexMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        keepAlive,
      };
      const messageBuffer = { addMessage: vi.fn() };
      const logger = { debug: vi.fn() };
      const diffProcessor = { processDiff: vi.fn() };

      const handler = createCodexMcpMessageHandler({
        logger,
        session,
        messageBuffer,
        sendReady,
        publishCodexThreadIdToMetadata: vi.fn(),
        diffProcessor,
        getCurrentTaskId: () => currentTaskId,
        setCurrentTaskId: (next: string | null) => {
          currentTaskId = next;
        },
        getThinking: () => thinking,
        setThinking: (next: boolean) => {
          thinking = next;
        },
      });

      handler({ type: 'agent_reasoning_delta', delta: '**Title**\n\nHello' });
      expect(session.sendAgentMessage).not.toHaveBeenCalled();
      expect(session.sendAgentMessageCommitted).toHaveBeenCalledWith(
        'codex',
        { type: 'thinking', text: '**Title**\n\nHello' },
        expect.objectContaining({
          localId: expect.any(String),
          meta: expect.objectContaining({
            happierStreamSegmentV1: expect.objectContaining({
              v: 1,
              segmentKind: 'thinking',
              segmentState: 'streaming',
            }),
          }),
        }),
      );
      expect(session.sendTranscriptDraftDelta).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({
          segmentKind: 'thinking',
          deltaText: '**Title**\n\nHello',
        }),
      );
      expect(session.sendCodexMessage).not.toHaveBeenCalled();
    } finally {
      process.env.HAPPIER_STREAM_DRAFT_FLUSH_MS = prevDraftFlush;
      process.env.HAPPIER_STREAM_CHECKPOINT_MS = prevCheckpointMs;
      process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS = prevMinChars;
    }
  });
});
