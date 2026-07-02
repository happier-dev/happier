import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from './reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildRuntimeAuthRecoveryScheduledResult } from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import { readRuntimeAuthFailureReportOutboxItems } from './reportOutbox/runtimeAuthFailureReportOutbox';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team-pool',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'stable_provider_message',
} satisfies ConnectedServiceRuntimeFailureClassification;

describe('reportConnectedServiceRuntimeAuthFailureToDaemon', () => {
  beforeEach(() => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  // Incident Jun-11 H-C / FIX-2: one failed turn can be observed by multiple independent
  // triggers, each calling this shared report path. Dedupe lives HERE — inside the single
  // owner in front of the daemon — keyed on stable identity only (no Date.now-derived
  // retryAfterMs), so all triggers are covered without per-call-site dedupers.
  describe('stable report dedupe', () => {
    const limitClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'pinned-profile',
      groupId: null,
      resetsAtMs: 1_781_221_200_000,
      planType: null,
      rateLimits: null,
      source: 'provider_runtime_marker',
    } as const;

    it('suppresses duplicate identical reports within the dedupe window and reuses the first daemon result', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      const first = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_1',
        switchesThisTurn: 0,
        // Volatile per-trigger timing must not defeat the dedupe key.
        classification: { ...limitClassification, retryAfterMs: 11_438_034 },
        notify,
        nowMs: () => 1_000,
      });
      const second = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_1',
        switchesThisTurn: 0,
        classification: { ...limitClassification, retryAfterMs: 11_437_958 },
        notify,
        nowMs: () => 1_300,
      });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('coalesces concurrent duplicate reports onto one in-flight daemon call', async () => {
      let resolveNotify!: (value: unknown) => void;
      const notify = vi.fn(() => new Promise<unknown>((resolve) => {
        resolveNotify = resolve;
      }));

      const firstPromise = reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_concurrent',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 1_000,
      });
      const secondPromise = reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_concurrent',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 1_050,
      });
      resolveNotify({ ok: true, result: { status: 'noop' } });
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('does not suppress reports with a different stable identity', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_2',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_2',
        switchesThisTurn: 0,
        classification: { ...limitClassification, kind: 'auth_expired' },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('does not suppress reports with different stable recovery actions', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_recovery_action',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          recoveryAction: { kind: 'provider_state_sharing_required' },
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_recovery_action',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          recoveryAction: { kind: 'quota_recovery_required' },
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('reports again once the dedupe window has elapsed', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_3',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_3',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 100_000,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('treats a changed switchesThisTurn as a new failure generation (not a duplicate)', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_4',
        switchesThisTurn: 0,
        classification: limitClassification,
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_4',
        switchesThisTurn: 1,
        classification: limitClassification,
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('does not hold the dedupe window after a failed delivery (next trigger is a legitimate retry)', async () => {
      const outboxDir = await createTempDir('happier-runtime-auth-report-dedupe-fail-');
      try {
        const notify = vi.fn(async () => {
          throw new Error('daemon unavailable');
        });

        await reportConnectedServiceRuntimeAuthFailureToDaemon({
          sessionId: 'sess_dedupe_5',
          switchesThisTurn: 0,
          classification: limitClassification,
          notify,
          logger: { debug: vi.fn() },
          reportOutboxDir: outboxDir,
          nowMs: () => 1_000,
        });
        await reportConnectedServiceRuntimeAuthFailureToDaemon({
          sessionId: 'sess_dedupe_5',
          switchesThisTurn: 0,
          classification: limitClassification,
          notify,
          logger: { debug: vi.fn() },
          reportOutboxDir: outboxDir,
          nowMs: () => 1_100,
        });

        expect(notify).toHaveBeenCalledTimes(2);
      } finally {
        await removeTempDir(outboxDir);
      }
    });
  });

  it('preserves typed runtime-auth recovery diagnostics returned by the daemon', async () => {
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 1234,
      },
    });
    const notify = vi.fn(async () => ({
      ok: true,
      result: scheduled,
    }));

    const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
      notify,
    });

    expect(notify).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
    }, {
      timeoutMs: 120_000,
    });
    expect(report.handled).toBe(true);
    expect(report.statusCode).toBe('recovery_retry_scheduled');
    expect(report.uxDiagnostic).toEqual(scheduled.uxDiagnostic);
    expect(report.projection?.transcriptEvent).toEqual(scheduled.transcriptEvent);
    expect(report.projection?.nextRetryAtMs).toBe(1234);
  });

  it('forwards an explicit custom resume prompt mode through the default daemon report body', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'recovery_retry_scheduled' },
    }));

    const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_custom_resume',
      switchesThisTurn: 2,
      classification,
      resumePromptMode: 'custom',
      notify,
    });

    expect(notify).toHaveBeenCalledWith({
      sessionId: 'sess_custom_resume',
      switchesThisTurn: 2,
      classification,
      resumePromptMode: 'custom',
    }, {
      timeoutMs: 120_000,
    });
    expect(report).toMatchObject({
      resumePromptMode: 'custom',
    });
  });

  it('drops malformed resume prompt modes before reporting to the daemon', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'recovery_retry_scheduled' },
    }));

    const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_malformed_resume',
      switchesThisTurn: 1,
      classification,
      resumePromptMode: 'later',
      notify,
    });

    expect(notify).toHaveBeenCalledWith({
      sessionId: 'sess_malformed_resume',
      switchesThisTurn: 1,
      classification,
    }, {
      timeoutMs: 120_000,
    });
    expect(report).not.toHaveProperty('resumePromptMode');
  });

  it('uses a runtime-auth-specific daemon timeout so quota probing and switch application can finish', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    }));

    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.any(Object), {
      timeoutMs: 120_000,
    });
  });

  it('keeps daemon notification failures non-fatal', async () => {
    const logger = { debug: vi.fn() };
    const notify = vi.fn(async () => {
      throw new Error('daemon unavailable');
    });

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      classification,
      notify,
      logger,
    })).resolves.toEqual({
      handled: false,
      report: null,
      statusCode: null,
      statusMessage: null,
    });
    expect(logger.debug).toHaveBeenCalled();
  });

  it('enqueues a sanitized outbox report when daemon notification fails', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-helper-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 2,
        resumePromptMode: 'custom',
        classification: {
          ...classification,
          accessToken: 'secret-access-token',
          rateLimits: { refreshToken: 'secret-refresh-token' },
        },
        notify: vi.fn(async () => {
          throw new Error('daemon unavailable');
        }),
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: null,
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_1',
        switchesThisTurn: 2,
        resumePromptMode: 'custom',
        classification: {
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team-pool',
          rateLimits: null,
        },
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not enqueue when daemon returns an accepted report that is not a local-control error', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-accepted-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        classification,
        notify: vi.fn(async () => ({
          ok: true,
          result: { status: 'credential_refreshed', restartRequested: true },
        })),
        reportOutboxDir: outboxDir,
      })).resolves.toMatchObject({
        handled: true,
      });

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
});
