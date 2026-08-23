import { mkdir, unlink, writeFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from './reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildRuntimeAuthRecoveryScheduledResult } from './projection/connectedServiceRuntimeAuthRecoveryProjection';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  readRuntimeAuthFailureReportOutboxItems,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
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
  it('preserves the daemon stable recovery receipt for exact cancellation projection', async () => {
    const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_receipt',
      classification,
      notify: vi.fn(async () => ({
        ok: true,
        result: { status: 'recovery_action_required' },
        recoveryReceipt: {
          reportId: 'runtime-auth-report:receipt-1',
          attemptId: 'runtime-auth-attempt:receipt-1',
        },
      })),
      createReportId: () => 'runtime-auth-report:receipt-1',
    });

    expect(report).toMatchObject({
      recoveryReceipt: {
        reportId: 'runtime-auth-report:receipt-1',
        attemptId: 'runtime-auth-attempt:receipt-1',
      },
    });
  });

  it('does not emit a legacy launcher-daemon incarnation from the runner environment', async () => {
    const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));
    const previousGeneration = process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-origin';
    try {
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-bound',
        classification,
        notify,
      });

      expect(notify).toHaveBeenCalledWith(expect.not.objectContaining({
        originDaemonExecutionGenerationV1: expect.anything(),
      }), expect.anything());
    } finally {
      if (previousGeneration === undefined) {
        delete process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
      } else {
        process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = previousGeneration;
      }
    }
  });

  it('coalesces the same provider failure independently of legacy daemon environment changes', async () => {
    const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-old';
    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'session-generation-dedupe',
      classification,
      notify,
      nowMs: () => 1_000,
    });
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-current';
    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'session-generation-dedupe',
      classification,
      notify,
      nowMs: () => 1_001,
    });

    expect(notify).toHaveBeenCalledOnce();
    delete process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
  });

  it('does not fork durable report identity across daemon replacement', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-generation-rejection-');
    try {
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-rejection',
        classification,
        notify: async () => {
          throw new Error('current daemon delivery was ambiguous');
        },
        reportOutboxDir: outboxDir,
        nowMs: () => 2_000,
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-rejection',
        classification,
        notify: async () => ({
          ok: true,
          result: { status: 'noop' },
        }),
        reportOutboxDir: outboxDir,
        nowMs: () => 2_001,
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'session-generation-rejection',
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('reuses a crash-staged report id while ignoring a legacy launcher-daemon field', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-crash-staged-report-');
    const notify = vi.fn(async () => ({ ok: true, result: { status: 'credential_refreshed', restartRequested: true } }));
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          reportId: 'runtime-auth-report:before-client-crash',
          originDaemonExecutionGenerationV1: 'legacy-launcher-daemon',
          sessionId: 'sess_crash_staged',
          switchesThisTurn: 0,
          classification,
        },
        nowMs: () => 1_000,
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        reportOutboxDir: outboxDir,
        sessionId: 'sess_crash_staged',
        switchesThisTurn: 0,
        classification,
        notify,
        nowMs: () => 2_000,
      });

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        reportId: 'runtime-auth-report:before-client-crash',
      }), expect.anything());
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not remove a successor queued while direct delivery is in flight', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-direct-successor-');
    let releaseNotify!: () => void;
    const notifyReleased = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    let markNotifyStarted!: () => void;
    const notifyStarted = new Promise<void>((resolve) => {
      markNotifyStarted = resolve;
    });
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'session-direct-successor',
          switchesThisTurn: 1,
          classification,
        },
        nowMs: () => 2_000,
      });

      const direct = reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-direct-successor',
        switchesThisTurn: 1,
        classification,
        notify: async () => {
          markNotifyStarted();
          await notifyReleased;
          return {
            ok: true,
            result: { status: 'credential_refreshed', restartRequested: true },
          };
        },
        reportOutboxDir: outboxDir,
        nowMs: () => 2_001,
      });
      await notifyStarted;

      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'session-direct-successor',
          switchesThisTurn: 2,
          classification,
        },
        nowMs: () => 2_002,
      });

      releaseNotify();
      await expect(direct).resolves.toMatchObject({ handled: true });
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([
        expect.objectContaining({
          sessionId: 'session-direct-successor',
          switchesThisTurn: 2,
        }),
      ]);
    } finally {
      releaseNotify?.();
      await removeTempDir(outboxDir);
    }
  });
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
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
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

    it('does not suppress usage-limit reports from different source provider accounts', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_source_account',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          sourceProviderAccountId: 'acct-a',
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_source_account',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          sourceProviderAccountId: 'acct-b',
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('does not suppress usage-limit reports from different failure-time group generations', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_generation',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          sourceProviderAccountId: 'acct-a',
          groupGeneration: 41,
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_generation',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          sourceProviderAccountId: 'acct-a',
          groupGeneration: 42,
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('does not suppress reports for different failing access token fingerprints', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_failing_token_fingerprint',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          failingAccessTokenFingerprint: 'sha256:old-failed-token',
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_failing_token_fingerprint',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          failingAccessTokenFingerprint: 'sha256:new-failed-token',
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('suppresses repeated reports for the same failing access token fingerprint', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_same_failing_token_fingerprint',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          failingAccessTokenFingerprint: 'sha256:failed-token',
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_same_failing_token_fingerprint',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          failingAccessTokenFingerprint: 'sha256:failed-token',
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('dedupes on sanitized provider identity instead of raw unsafe provider values', async () => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_sanitized',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          providerLimitId: 'Bearer raw-token-a',
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_sanitized',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          providerLimitId: 'Bearer raw-token-b',
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(1);
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
      reportId: expect.stringMatching(/^runtime-auth-report:/),
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

  it('sends a sanitized classification in the local daemon notification body', async () => {
    const notify = vi.fn(async (_body: unknown, _options?: unknown) => ({
      ok: true,
      result: { status: 'recovery_retry_scheduled' },
    }));

    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_sanitized_notify',
      switchesThisTurn: 1,
      classification: {
        ...classification,
        providerLimitId: 'Bearer raw-token',
        planType: 'secret-enterprise-plan',
        action: { kind: 'open_url', url: 'https://example.com/recover?api_key=secret' },
        accessToken: 'secret-access-token',
        rawProviderPayload: { body: 'raw-provider-body' },
      },
      notify,
    });

    const body = notify.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      sessionId: 'sess_sanitized_notify',
      switchesThisTurn: 1,
      classification: {
        ...classification,
        providerLimitId: null,
        planType: null,
        action: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain('raw-token');
    expect(JSON.stringify(body)).not.toContain('secret-enterprise-plan');
    expect(JSON.stringify(body)).not.toContain('api_key=secret');
    expect(JSON.stringify(body)).not.toContain('secret-access-token');
    expect(JSON.stringify(body)).not.toContain('raw-provider-body');
  });

  it('drops malformed classifications before local notification or outbox persistence', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-invalid-classification-');
    try {
      const notify = vi.fn(async () => ({
        ok: true,
        result: { status: 'recovery_retry_scheduled' },
      }));

      const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_invalid_classification',
        switchesThisTurn: 1,
        classification: {
          kind: 'usage_limit',
          // Missing required serviceId/source means the sender cannot prove this body is safe.
          accessToken: 'secret-access-token',
          rawProviderPayload: { body: 'raw-provider-body' },
        },
        notify,
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
      });

      expect(report).toEqual({
        handled: false,
        report: null,
        statusCode: null,
        statusMessage: null,
      });
      expect(notify).not.toHaveBeenCalled();
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
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
      reportId: expect.stringMatching(/^runtime-auth-report:/),
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
      reportId: expect.stringMatching(/^runtime-auth-report:/),
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

  it('never logs a raw local path, secret, resume id, or stack from a report failure', async () => {
    const logger = { debug: vi.fn() };
    const raw = Object.assign(
      new Error(
        "EACCES: permission denied, open '/Users/someone/work/.happier/runtime-auth.json'"
        + ' authorization=Bearer sk-abcdefghijklmnop resumeId=codex-thread-9911',
      ),
      { code: 'EACCES' },
    );
    const notify = vi.fn(async () => {
      throw raw;
    });

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      classification,
      notify,
      logger,
    })).resolves.toMatchObject({ handled: false });

    expect(logger.debug).toHaveBeenCalled();
    const logged = logger.debug.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('/Users/someone/work');
    expect(logged).not.toContain('sk-abcdefghijklmnop');
    expect(logged).not.toContain('codex-thread-9911');
    expect(logged).not.toContain('reportConnectedServiceRuntimeAuthFailureToDaemon.test');
    expect(logged).toContain('EACCES');
  });

  it('enqueues a sanitized outbox report when daemon notification fails', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-helper-');
    try {
      const scheduleOutboxDrain = vi.fn();
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
        scheduleOutboxDrain,
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
      expect(scheduleOutboxDrain).toHaveBeenCalledOnce();
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('retains custody when initial outbox staging and daemon notification both fail', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-double-failure-');
    const scheduleOutboxDrain = vi.fn();
    try {
      await removeTempDir(outboxDir);
      await writeFile(outboxDir, 'temporarily unavailable', 'utf8');

      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_double_failure',
        switchesThisTurn: 2,
        classification,
        notify: vi.fn(async () => {
          await unlink(outboxDir);
          await mkdir(outboxDir);
          throw new Error('daemon unavailable');
        }),
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: null,
      });

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([
        expect.objectContaining({
          sessionId: 'sess_double_failure',
          switchesThisTurn: 2,
        }),
      ]);
      expect(scheduleOutboxDrain).toHaveBeenCalledOnce();
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not reschedule the outbox drain when the same retryable report only coalesces an existing item', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-coalesced-schedule-');
    try {
      const scheduleOutboxDrain = vi.fn();
      const notify = vi.fn(async () => {
        throw new Error('daemon unavailable');
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_schedule_coalesced',
        switchesThisTurn: 2,
        classification,
        notify,
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
        nowMs: () => 1_700_000_000_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_schedule_coalesced',
        switchesThisTurn: 2,
        classification,
        notify,
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
        nowMs: () => 1_700_000_000_500,
      });

      expect(scheduleOutboxDrain).toHaveBeenCalledTimes(1);
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        attemptCount: 2,
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('enqueues a sanitized outbox report when daemon shutdown defers recovery intake', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-shutdown-deferral-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_shutdown_deferral',
        switchesThisTurn: 1,
        classification: {
          ...classification,
          providerLimitId: 'refresh-token-secret',
          accessToken: 'secret-access-token',
          rawProviderPayload: { body: 'raw-provider-body' },
        },
        notify: vi.fn(async () => ({
          ok: true,
          result: {
            status: 'daemon_lifecycle_unavailable',
            reason: 'recovery_deferred_shutdown',
          },
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: true,
          result: {
            status: 'daemon_lifecycle_unavailable',
            reason: 'recovery_deferred_shutdown',
          },
        },
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_shutdown_deferral',
        switchesThisTurn: 1,
        classification: {
          ...classification,
          providerLimitId: null,
        },
      });
      expect(JSON.stringify(items[0])).not.toContain('secret-access-token');
      expect(JSON.stringify(items[0])).not.toContain('raw-provider-body');
      expect(JSON.stringify(items[0])).not.toContain('refresh-token-secret');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('retains custody when presentation is handled without a matching recovery receipt', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-accepted-');
    const scheduleOutboxDrain = vi.fn();
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        classification,
        notify: vi.fn(async () => ({
          ok: true,
          result: { status: 'credential_refreshed', restartRequested: true },
        })),
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
      })).resolves.toMatchObject({
        handled: true,
      });

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(1);
      expect(scheduleOutboxDrain).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('removes custody only when daemon returns the exact staged report receipt', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-receipted-');
    const reportId = 'runtime-auth-report:matching-receipt';
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        classification,
        createReportId: () => reportId,
        notify: vi.fn(async () => ({
          ok: true,
          recoveryReceipt: {
            reportId,
            attemptId: 'runtime-auth-attempt:matching-receipt',
          },
          result: { status: 'credential_refreshed', restartRequested: true },
        })),
        reportOutboxDir: outboxDir,
      })).resolves.toMatchObject({
        handled: true,
        recoveryReceipt: { reportId },
      });

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
});
