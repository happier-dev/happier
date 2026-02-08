import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  followers: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
  resolveStart: null as (() => void) | null,
}));

vi.mock('@/backends/utils/jsonlFollower', () => ({
  JsonlFollower: class MockJsonlFollower {
    start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          state.resolveStart = resolve;
        }),
    );
    stop = vi.fn(async () => {});

    constructor(_: unknown) {
      state.followers.push(this as unknown as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> });
    }
  },
}));

import { CodexRolloutMirror } from '../codexRolloutMirror';

describe('CodexRolloutMirror lifecycle', () => {
  beforeEach(() => {
    state.followers.length = 0;
    state.resolveStart = null;
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
});
