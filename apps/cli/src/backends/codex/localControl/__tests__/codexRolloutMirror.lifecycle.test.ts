import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  followers: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    opts: { onJson: (value: unknown) => void | Promise<void> };
  }>,
  resolveStart: null as (() => void) | null,
  operationLog: [] as string[],
  appendAfterFlushCount: 0,
}));

vi.mock('@/agent/localControl/jsonlFollower', () => ({
  JsonlFollower: class MockJsonlFollower {
    start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          state.resolveStart = resolve;
        }),
    );
    stop = vi.fn(async () => {});

    constructor(opts: { onJson: (value: unknown) => void | Promise<void> }) {
      state.followers.push({
        start: this.start,
        stop: this.stop,
        opts,
      });
    }
  },
}));

vi.mock('@/api/session/streamedTranscriptWriter', () => ({
  createStreamedTranscriptWriter: () => ({
    appendAssistantDelta: (text: string) => {
      state.operationLog.push(`append:${text}`);
      if (state.operationLog.includes('flush:turn-end')) {
        state.appendAfterFlushCount += 1;
      }
    },
    appendThinkingDelta: () => {},
    flushAll: vi.fn(async (opts: { reason: 'tool-call-boundary' | 'turn-end' | 'abort' }) => {
      state.operationLog.push(`flush:${opts.reason}`);
    }),
  }),
}));

import { CodexRolloutMirror } from '../codexRolloutMirror';

describe('CodexRolloutMirror lifecycle', () => {
  beforeEach(() => {
    state.followers.length = 0;
    state.resolveStart = null;
    state.operationLog.length = 0;
    state.appendAfterFlushCount = 0;
  });

  it('stops follower if stop is called while start is still pending', async () => {
    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/mock.jsonl',
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendSessionEvent: () => {},
      } as any,
    });

    const startPromise = mirror.start();
    await Promise.resolve();

    expect(state.followers).toHaveLength(1);
    const follower = state.followers[0];

    const stopPromise = mirror.stop();
    expect(follower.stop).toHaveBeenCalledTimes(1);

    state.resolveStart?.();
    await Promise.all([startPromise, stopPromise]);

    expect(follower.stop).toHaveBeenCalledTimes(2);
  });

  it('stops the follower before the final transcript flush', async () => {
    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/mock.jsonl',
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendSessionEvent: () => {},
      } as any,
    });

    const startPromise = mirror.start();
    await Promise.resolve();
    state.resolveStart?.();
    await startPromise;

    expect(state.followers).toHaveLength(1);
    const follower = state.followers[0];
    follower.stop.mockImplementationOnce(async () => {
      state.operationLog.push('stop:start');
      await follower.opts.onJson({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'late delta' }] },
      });
      state.operationLog.push('stop:end');
    });

    await mirror.stop();

    expect(state.appendAfterFlushCount).toBe(0);
    expect(state.operationLog).toEqual(['stop:start', 'append:late delta', 'stop:end', 'flush:turn-end']);
  });
});
