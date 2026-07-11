import { afterEach, describe, expect, it, vi } from 'vitest';

import { createElevenLabsSessionLifecycle } from './elevenLabsSessionLifecycle.js';

const translate = (key: string, params?: Readonly<Record<string, unknown>>) =>
  `${key}:${JSON.stringify(params ?? {})}`;

afterEach(() => vi.useRealTimers());

describe('createElevenLabsSessionLifecycle', () => {
  it('completes an active hosted lease exactly once and never completes BYO', async () => {
    const completeSession = vi.fn(async () => undefined);
    const lifecycle = createElevenLabsSessionLifecycle({
      getCredentials: vi.fn(async () => ({ token: 'token', secret: 'secret' })),
      completeSession,
      appendNote: vi.fn(),
      translate,
    });
    lifecycle.started({
      controlSessionId: 'control-hosted',
      conversationId: 'conversation-hosted',
      prepared: {
        sessionConfig: {},
        sessionState: { billingMode: 'happier', leaseId: 'lease-1', expiresAtMs: null },
      },
    });
    await lifecycle.ended();
    await lifecycle.ended();
    expect(completeSession).toHaveBeenCalledTimes(1);
    expect(completeSession).toHaveBeenCalledWith(expect.anything(), {
      leaseId: 'lease-1',
      providerConversationId: 'conversation-hosted',
    });

    lifecycle.started({
      controlSessionId: 'control-byo',
      conversationId: 'conversation-byo',
      prepared: {
        sessionConfig: {},
        sessionState: { billingMode: 'byo', leaseId: null, expiresAtMs: null },
      },
    });
    await lifecycle.ended();
    expect(completeSession).toHaveBeenCalledTimes(1);
  });

  it('owns bounded lease announcements and cancels timers on teardown', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const appendNote = vi.fn();
    const lifecycle = createElevenLabsSessionLifecycle({
      now: () => now,
      getCredentials: vi.fn(async () => null),
      completeSession: vi.fn(async () => undefined),
      appendNote,
      translate,
    });
    lifecycle.started({
      controlSessionId: 'control-timer',
      conversationId: 'conversation-timer',
      prepared: {
        sessionConfig: {},
        sessionState: { billingMode: 'happier', leaseId: 'lease-timer', expiresAtMs: 121_000 },
      },
    });
    expect(appendNote).toHaveBeenCalledTimes(1);
    now = 61_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(appendNote).toHaveBeenCalledTimes(2);
    await lifecycle.ended();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(appendNote).toHaveBeenCalledTimes(2);
  });
});
