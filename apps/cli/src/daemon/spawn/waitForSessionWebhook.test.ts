import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

import { waitForSessionWebhook } from './waitForSessionWebhook';

describe('waitForSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves success when webhook arrives before timeout', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 42,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
    });

    const resolver = pidToAwaiter.get(42);
    expect(typeof resolver).toBe('function');
    resolver?.({ happySessionId: 'session-1' });

    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(pidToAwaiter.has(42)).toBe(false);
    expect(pidToSpawnResultResolver.has(42)).toBe(false);
    expect(pidToSpawnWebhookTimeout.has(42)).toBe(false);
  });

  it('resolves timeout error and cleans maps when webhook does not arrive', async () => {
    vi.useFakeTimers();

    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 77,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 77',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 77',
    });
    expect(pidToAwaiter.has(77)).toBe(false);
    expect(pidToSpawnResultResolver.has(77)).toBe(false);
    expect(pidToSpawnWebhookTimeout.has(77)).toBe(false);
  });

  it('allows late webhook within default timeout window', async () => {
    vi.useFakeTimers();
    const previous = process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;

    try {
      const pidToAwaiter = new Map<number, (session: any) => void>();
      const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
      const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

      const promise = waitForSessionWebhook({
        pid: 88,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        timeoutErrorMessage: 'Session webhook timeout for PID 88',
      });

      vi.advanceTimersByTime(65_000);

      const resolver = pidToAwaiter.get(88);
      expect(typeof resolver).toBe('function');
      resolver?.({ happySessionId: 'session-late' });

      await expect(promise).resolves.toEqual({
        type: 'success',
        sessionId: 'session-late',
      });
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
      else process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = previous;
    }
  });

  it('resolves immediately when a canonical session id is already available', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 5150,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
      resolveExistingSessionId: () => 'session-ready-5150',
    });

    expect(pidToAwaiter.size).toBe(0);
    expect(pidToSpawnResultResolver.size).toBe(0);
    expect(pidToSpawnWebhookTimeout.size).toBe(0);
    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-ready-5150',
    });
  });
});
