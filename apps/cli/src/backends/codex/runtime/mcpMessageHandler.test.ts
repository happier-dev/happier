import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexMcpMessageHandler,
  forwardCodexErrorToUi,
  forwardCodexStatusToUi,
} from './mcpMessageHandler';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it('normalizes raw Codex token_count telemetry before forwarding it to the session', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
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

    handler({
      type: 'token_count',
      info: {
        total_token_usage: {
          total_tokens: 184,
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 35,
          reasoning_output_tokens: 9,
        },
        model_context_window: 258400,
      },
    });

    expect(session.sendCodexMessage).toHaveBeenCalledWith({
      type: 'token_count',
      id: expect.any(String),
      source: 'codex-mcp-token-count',
      scope: 'session_cumulative',
      tokens: {
        total: 184,
        input: 120,
        cache_read: 20,
        output: 35,
        thought: 9,
      },
      context_used_tokens: 184,
      context_window_tokens: 258400,
    });
  });

  it('logs MCP message shapes without leaking string payloads', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
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

    handler({ type: 'agent_message', message: 'SUPER_SECRET_VALUE' });

    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('does not throw when receiving circular event payloads', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
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

  it('tracks thinking state and emits ready only after transcript flush completes on task completion', async () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const keepAlive = vi.fn();
    const sendReady = vi.fn();
    let resolveInitialCommit: (() => void) | undefined;
    let durableCommitCount = 0;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {
        durableCommitCount += 1;
        if (durableCommitCount === 1) {
          await new Promise<void>((resolve) => {
            resolveInitialCommit = resolve;
          });
        }
      }),
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

    handler({ type: 'agent_message', message: 'Hello from Codex' });
    handler({ type: 'task_complete' });

    await Promise.resolve();
    expect(thinking).toBe(false);
    expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(sendReady).not.toHaveBeenCalled();

    const releaseInitialCommit = resolveInitialCommit;
    if (!releaseInitialCommit) {
      throw new Error('expected initial durable commit resolver');
    }
    releaseInitialCommit();
    await vi.waitFor(() => {
      expect(sendReady).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['turn_failed', 'failed'],
    ['turn_cancelled', 'cancelled'],
    ['turn_aborted', 'aborted'],
  ] as const)('treats %s as a terminal turn event', async (type, label) => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const keepAlive = vi.fn();
    const sendReady = vi.fn();
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
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
    handler({ type });

    expect(thinking).toBe(false);
    expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(`Turn ${label}`, 'status');
    await vi.waitFor(() => {
      expect(sendReady).toHaveBeenCalledTimes(1);
    });
  });

  it('streams agent_message text through transcript-vNext instead of creating standalone Codex rows', () => {
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');

      let thinking = false;
      let currentTaskId: string | null = null;
      const session = {
        sendAgentMessage: vi.fn(),
        sendAgentMessageCommitted: vi.fn(async () => {}),
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

      handler({ type: 'agent_message', message: 'Hello from Codex' });

      expect(session.sendAgentMessageCommitted).toHaveBeenCalledWith(
        'codex',
        { type: 'message', message: 'Hello from Codex' },
        expect.objectContaining({
          localId: expect.any(String),
          meta: expect.objectContaining({
            happierStreamSegmentV1: expect.objectContaining({
              v: 1,
              segmentKind: 'assistant',
              segmentState: 'streaming',
            }),
          }),
        }),
      );
      expect(session.sendCodexMessage).not.toHaveBeenCalled();
  });

  it('streams agent_reasoning deltas as ACP thinking messages (not tool calls)', () => {
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');

      let thinking = false;
      let currentTaskId: string | null = null;
      const keepAlive = vi.fn();
      const sendReady = vi.fn();
      const session = {
        sendAgentMessage: vi.fn(),
        sendAgentMessageCommitted: vi.fn(async () => {}),
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
      expect(session.sendCodexMessage).not.toHaveBeenCalled();
  });

  it('normalizes built-in Happier MCP tool names before emitting Codex tool-call events', () => {
    let thinking = false;
    let currentTaskId: string | null = null;
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
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

    handler({
      type: 'mcp_tool_call_begin',
      call_id: 'call_1',
      invocation: {
        server: 'happier__happier',
        tool: 'change_title',
        arguments: {
          title: 'Normalized title',
        },
      },
    });

    expect(session.sendCodexMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-call',
        name: 'mcp__happier__change_title',
        callId: 'call_1',
        input: {
          title: 'Normalized title',
        },
      }),
    );
  });
});
