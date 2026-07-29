import { describe, expect, it, vi } from 'vitest';

import {
  admitPersistedTakeoverBeforeRuntime,
  primeAgentStateForUi,
  reportPersistedTakeoverRuntimeBound,
  reportSessionToDaemonIfRunning,
} from '@/agent/runtime/startupSideEffects';
import type { Metadata } from '@/api/types';

const metadataStub = {} as Metadata;

describe('startup side effects: daemon session reporting retry', () => {
  it('requires one exact daemon acknowledgement for persisted-takeover admission', async () => {
    const notifyDaemonSessionStartedFn = vi.fn(async () => ({ status: 'ok' as const }));

    await admitPersistedTakeoverBeforeRuntime({
      sessionId: 'session-takeover',
      metadata: { startedBy: 'daemon' } as Metadata,
      correlation: {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    }, {
      notifyDaemonSessionStartedFn,
      reportAttemptTimeoutMs: 1_234,
    });

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledWith(
      'session-takeover',
      { startedBy: 'daemon' },
      {
        timeoutMs: 1_234,
        persistedTakeoverAdmission: {
          operationId: 'operation-1',
          attemptId: 'attempt-1',
          phase: 'admit',
        },
      },
    );
  });

  it('reports runtime_bound through the same exact private request', async () => {
    const notifyDaemonSessionStartedFn = vi.fn(async () => ({ status: 'ok' as const }));

    await reportPersistedTakeoverRuntimeBound({
      sessionId: 'session-takeover',
      metadata: { startedBy: 'daemon' } as Metadata,
      correlation: {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    }, {
      notifyDaemonSessionStartedFn,
      reportAttemptTimeoutMs: 1_234,
    });

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledWith(
      'session-takeover',
      { startedBy: 'daemon' },
      {
        timeoutMs: 1_234,
        persistedTakeoverAdmission: {
          operationId: 'operation-1',
          attemptId: 'attempt-1',
          phase: 'runtime_bound',
        },
      },
    );
  });

  it('retries one ambiguous runtime_bound response with the exact same attempt', async () => {
    const notifyDaemonSessionStartedFn = vi.fn()
      .mockResolvedValueOnce({
        error: 'Request failed: /session-started, response ended before acknowledgement',
      })
      .mockResolvedValueOnce({ status: 'ok' as const });
    const report = {
      sessionId: 'session-takeover',
      metadata: { startedBy: 'daemon' } as Metadata,
      correlation: {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    };

    await reportPersistedTakeoverRuntimeBound(report, {
      notifyDaemonSessionStartedFn,
      reportAttemptTimeoutMs: 1_234,
    });

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(2);
    expect(notifyDaemonSessionStartedFn).toHaveBeenNthCalledWith(
      1,
      'session-takeover',
      { startedBy: 'daemon' },
      {
        timeoutMs: 1_234,
        persistedTakeoverAdmission: {
          operationId: 'operation-1',
          attemptId: 'attempt-1',
          phase: 'runtime_bound',
        },
      },
    );
    expect(notifyDaemonSessionStartedFn).toHaveBeenNthCalledWith(
      2,
      'session-takeover',
      { startedBy: 'daemon' },
      {
        timeoutMs: 1_234,
        persistedTakeoverAdmission: {
          operationId: 'operation-1',
          attemptId: 'attempt-1',
          phase: 'runtime_bound',
        },
      },
    );
  });

  it('fails runtime_bound closed after one bounded identical retry', async () => {
    const notifyDaemonSessionStartedFn = vi.fn(async () => ({
      error: 'Request failed: /session-started, response ended before acknowledgement',
    }));

    await expect(reportPersistedTakeoverRuntimeBound({
      sessionId: 'session-takeover',
      metadata: { startedBy: 'daemon' } as Metadata,
      correlation: {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    }, {
      notifyDaemonSessionStartedFn,
      reportAttemptTimeoutMs: 1_234,
    })).rejects.toMatchObject({
      code: 'persisted_takeover_admission_ambiguous',
    });

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(2);
  });

  it('fails persisted-takeover admission closed on a 503 or ambiguous response', async () => {
    await expect(admitPersistedTakeoverBeforeRuntime({
      sessionId: 'session-takeover',
      metadata: { startedBy: 'daemon' } as Metadata,
      correlation: {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    }, {
      notifyDaemonSessionStartedFn: async () => ({
        error: 'Request failed: /session-started, HTTP 503',
        errorCode: 'persisted_takeover_admission_failed',
      }),
    })).rejects.toMatchObject({
      code: 'persisted_takeover_admission_failed',
    });
  });

  it('does not emit unhandledRejection when priming agent state fails', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = {
        updateAgentState: async () => {
          throw new Error('updateAgentState failed');
        },
      };

      primeAgentStateForUi(session as any, '[Test]');

      // Give Node a chance to surface an unhandled rejection if one was created.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('retries transient daemon-unavailable errors and succeeds', async () => {
    const errors = [
      { error: 'No daemon running, no state file found' },
      { error: 'No daemon running, no state file found' },
      {},
    ];
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-1', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async () => {
          const next = errors[calls] ?? {};
          calls++;
          return next;
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 1_000,
        retryIntervalMs: 100,
      },
    );

    expect(calls).toBe(3);
  });

  it('retries daemon report when control auth is temporarily out of sync', async () => {
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-2', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async () => {
          calls++;
          return { error: 'Unauthorized' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 1_000,
        retryIntervalMs: 100,
      },
    );

    expect(calls).toBeGreaterThan(1);
  });

  it('uses a bounded HTTP timeout per daemon-report attempt', async () => {
    const observedTimeouts: Array<number | null | undefined> = [];

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-3', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return {};
        },
      },
    );

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-3b', metadata: { startedBy: 'daemon' } as Metadata },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return {};
        },
      },
    );

    expect(observedTimeouts).toEqual([2_500, 10_000]);
  });

  it('uses a longer default retry window for daemon-started sessions', async () => {
    let calls = 0;
    let now = 0;

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-4', metadata: { startedBy: 'daemon' } as Metadata },
      {
        notifyDaemonSessionStartedFn: async () => {
          calls++;
          return { error: 'No daemon running, no state file found' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryIntervalMs: 30_000,
      },
    );

    // With retryInterval=30s and daemon-default retryTimeout=90s, we should observe:
    // attempt at t=0, 30s, 60s, 90s (then stop).
    expect(calls).toBe(4);
  });

  it('uses a longer default retry window when daemon autostart is enabled for terminal sessions', async () => {
    const previousAutostart = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';

    try {
      let calls = 0;
      let now = 0;

      await reportSessionToDaemonIfRunning(
        { sessionId: 'session-5', metadata: metadataStub },
        {
          notifyDaemonSessionStartedFn: async () => {
            calls++;
            return { error: 'No daemon running, no state file found' };
          },
          sleepFn: async (ms) => {
            now += ms;
          },
          nowFn: () => now,
          retryIntervalMs: 10_000,
        },
      );

      // With daemon autostart enabled we should keep retrying past the old 10s terminal window:
      // attempt at t=0, 10s, 20s, 30s (then stop).
      expect(calls).toBe(4);
    } finally {
      if (previousAutostart === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
      else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = previousAutostart;
    }
  });

  it('throws after bounded retries when daemon readiness acknowledgement is required', async () => {
    let calls = 0;
    let now = 0;

    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-required-readiness',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async () => {
          calls++;
          return { error: 'Request failed with status code 503' };
        },
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
        retryTimeoutMs: 200,
        retryIntervalMs: 100,
      },
    )).rejects.toThrow('Daemon session readiness was not acknowledged');

    expect(calls).toBe(3);
  });

  it('keeps terminal and attach-style daemon reporting best effort by default', async () => {
    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-best-effort',
        metadata: { startedBy: 'terminal' } as Metadata,
      },
      {
        notifyDaemonSessionStartedFn: async () => {
          throw new Error('non-transient observer failure');
        },
        retryTimeoutMs: 0,
      },
    )).resolves.toBeUndefined();
  });
});
