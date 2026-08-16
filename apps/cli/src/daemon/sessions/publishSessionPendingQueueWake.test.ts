import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  infoFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({ logger: loggerMocks }));

import { publishSessionPendingQueueWake } from './publishSessionPendingQueueWake';

describe('publishSessionPendingQueueWake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a fulfilled unavailable result instead of silently discarding it', async () => {
    publishSessionPendingQueueWake({
      sessionId: 'sess-terminating',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'unavailable', reason: 'runtime_terminating' }),
    });

    await vi.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake unavailable',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-terminating',
        trigger: 'attach',
        outcome: 'unavailable',
        reason: 'runtime_terminating',
      },
    ));
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });

  it('records a published wake without changing the fire-and-forget contract', async () => {
    publishSessionPendingQueueWake({
      sessionId: 'sess-live',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => ({ type: 'wake_published' }),
    });

    await vi.waitFor(() => expect(loggerMocks.infoFile).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake published',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-live',
        trigger: 'attach',
        outcome: 'published',
      },
    ));
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('records a safe error outcome while retaining detailed rejection at debug level', async () => {
    const requestError = new Error('wake transport failed');
    publishSessionPendingQueueWake({
      sessionId: 'sess-rpc-failed',
      isShutdownRequested: () => false,
      logLabel: 'attach',
      requestWake: async () => { throw requestError; },
    });

    await vi.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledWith(
      '[DAEMON RUN] Pending queue wake failed',
      {
        event: 'pending_queue_wake',
        sessionId: 'sess-rpc-failed',
        trigger: 'attach',
        outcome: 'error',
      },
    ));
    expect(loggerMocks.debug).toHaveBeenCalledOnce();
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });

  it('does not request or report a wake after shutdown starts', async () => {
    const requestWake = vi.fn(async () => ({ type: 'wake_published' as const }));
    publishSessionPendingQueueWake({
      sessionId: 'sess-shutdown',
      isShutdownRequested: () => true,
      logLabel: 'attach',
      requestWake,
    });
    await Promise.resolve();

    expect(requestWake).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(loggerMocks.infoFile).not.toHaveBeenCalled();
  });
});
