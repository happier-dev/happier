import { describe, expect, it } from 'vitest';

import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import type { Metadata } from '@/api/types';

const metadataStub = {} as Metadata;

describe('startup side effects: daemon session reporting retry', () => {
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
    const observedTimeouts: Array<number | undefined> = [];

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-3', metadata: metadataStub },
      {
        notifyDaemonSessionStartedFn: async (_sessionId, _metadata, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return {};
        },
      },
    );

    expect(observedTimeouts).toEqual([2_500]);
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
});
