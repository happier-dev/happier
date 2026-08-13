import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
} from '@/agent/runtime/startupSideEffects';
import { configuration } from '@/configuration';
import { readTerminalAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import type { Metadata } from '@/api/types';

const metadataStub = {} as Metadata;

describe('startup side effects: daemon session reporting retry', () => {
  it('reports newer concurrent metadata even when the older in-flight report succeeds', async () => {
    let releaseFirstAttempt!: (value: { error?: string }) => void;
    const firstAttempt = new Promise<{ error?: string }>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const observedMetadata: Metadata[] = [];
    const notifyDaemonSessionStartedFn = vi.fn(async (_sessionId: string, metadata: Metadata) => {
      observedMetadata.push(metadata);
      return observedMetadata.length === 1 ? await firstAttempt : {};
    });
    const deps = { notifyDaemonSessionStartedFn };

    const first = reportSessionToDaemonIfRunning(
      { sessionId: 'session-newer-metadata', metadata: { startedBy: 'terminal' } as Metadata },
      deps,
    );
    await vi.waitFor(() => expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(1));
    const latestMetadata = { startedBy: 'daemon', claudeSessionId: 'claude-current' } as Metadata;
    const second = reportSessionToDaemonIfRunning(
      { sessionId: 'session-newer-metadata', metadata: latestMetadata, requireDaemonAck: true },
      deps,
    );

    releaseFirstAttempt({});
    await Promise.all([first, second]);

    expect(observedMetadata).toEqual([
      { startedBy: 'terminal' },
      latestMetadata,
    ]);
  });

  it('coalesces concurrent reports for one session and retries with the latest metadata and strongest readiness requirement', async () => {
    let releaseFirstAttempt!: (value: { error?: string }) => void;
    const firstAttempt = new Promise<{ error?: string }>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const observedMetadata: Metadata[] = [];
    const onFirstReported = vi.fn(async () => {});
    const onSecondReported = vi.fn(async () => {});
    let calls = 0;
    let now = 0;
    const notifyDaemonSessionStartedFn = vi.fn(async (_sessionId: string, metadata: Metadata) => {
      observedMetadata.push(metadata);
      calls += 1;
      if (calls === 1) return await firstAttempt;
      return {};
    });
    const commonDeps = {
      notifyDaemonSessionStartedFn,
      sleepFn: async (ms: number) => {
        now += ms;
      },
      nowFn: () => now,
      retryTimeoutMs: 1_000,
      retryIntervalMs: 100,
    };

    const first = reportSessionToDaemonIfRunning(
      { sessionId: 'session-coalesced', metadata: { startedBy: 'terminal' } as Metadata },
      { ...commonDeps, onReported: onFirstReported },
    );
    await vi.waitFor(() => expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(1));
    const latestMetadata = { startedBy: 'daemon', claudeSessionId: 'claude-current' } as Metadata;
    const second = reportSessionToDaemonIfRunning(
      { sessionId: 'session-coalesced', metadata: latestMetadata, requireDaemonAck: true },
      { ...commonDeps, onReported: onSecondReported },
    );

    releaseFirstAttempt({ error: 'No daemon running, no state file found' });
    await Promise.all([first, second]);

    expect(notifyDaemonSessionStartedFn).toHaveBeenCalledTimes(2);
    expect(observedMetadata).toEqual([
      { startedBy: 'terminal' },
      latestMetadata,
    ]);
    expect(onFirstReported).toHaveBeenCalledTimes(1);
    expect(onSecondReported).toHaveBeenCalledTimes(1);
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
      { error: 'Request failed: /session-started, HTTP 503 (session_startup_reconciliation_failed)' },
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

  it('invokes the daemon-reported callback after a retry succeeds', async () => {
    const errors = [
      { error: 'No daemon running, no state file found' },
      {},
    ];
    let calls = 0;
    let now = 0;
    const onReported = vi.fn(async () => {});

    await reportSessionToDaemonIfRunning(
      { sessionId: 'session-reported', metadata: metadataStub },
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
        onReported,
      },
    );

    expect(calls).toBe(2);
    expect(onReported).toHaveBeenCalledTimes(1);
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

  it('fails closed when a readiness report exhausts retries without daemon acknowledgement', async () => {
    await expect(reportSessionToDaemonIfRunning(
      {
        sessionId: 'session-readiness',
        metadata: { startedBy: 'daemon' } as Metadata,
        requireDaemonAck: true,
      },
      {
        notifyDaemonSessionStartedFn: async () => ({ error: 'No daemon running, no state file found' }),
        nowFn: () => 1_000,
        retryTimeoutMs: 0,
      },
    )).rejects.toThrow('Claude runtime readiness was not acknowledged by the daemon');
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
});

describe('startup side effects: terminal attachment persistence', () => {
  it('persists a bound v2 record for a tmux spawn that the stop-path disposition retires instead of parking as legacy', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-attachment-'));
    const originalHappyHomeDir = configuration.happyHomeDir;
    // Narrow test-harness override: happyHomeDir is resolved from env once at process start.
    (configuration as { happyHomeDir: string }).happyHomeDir = happyHomeDir;
    try {
      const sessionId = 'sess-tmux-spawn-v2';
      await persistTerminalAttachmentInfoIfNeeded({
        sessionId,
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happier:happy-window-1', tmpDir: '/tmp/happier-tmux' },
        } as NonNullable<Metadata['terminal']>,
      });

      const state = await readTerminalAttachmentState({ happyHomeDir, sessionId });
      if (state.status !== 'present' || state.info.version !== 2) {
        throw new Error(`Expected a bound version-2 attachment record, got ${JSON.stringify(state)}`);
      }
      expect(state.info.handle.kind).toBe('tmux');
      expect(state.info.handle.attachmentId).toBe(state.info.attachmentId);

      const disposition = await executeTerminalHostDisposition({
        happyHomeDir,
        sessionId,
        expectedAttachmentId: state.info.attachmentId,
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
      });
      expect(disposition).toEqual({ status: 'retired', attachmentId: state.info.attachmentId });
      await expect(readTerminalAttachmentState({ happyHomeDir, sessionId })).resolves.toEqual({ status: 'absent' });
    } finally {
      (configuration as { happyHomeDir: string }).happyHomeDir = originalHappyHomeDir;
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
