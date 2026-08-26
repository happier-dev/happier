import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS } from '../broker/brokerBridgeCallSource';

import {
  CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from './reportConnectedServiceRuntimeAuthFailureToDaemon';
import {
  enqueueRuntimeAuthFailureReportOutboxItem,
  readRuntimeAuthFailureReportOutboxItems,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const classifiedFailure = {
  kind: 'auth_expired',
  serviceId: 'openai-codex',
  profileId: 'work',
  groupId: 'codex-group',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'stable_provider_message',
} as const;

describe('reportConnectedServiceRuntimeAuthFailureToDaemon', () => {
  it('uses the same outer recovery budget as the generated provider bridge', () => {
    expect(CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS).toBe(
      CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS,
    );
  });

  it('does not emit a legacy launcher-daemon incarnation from the runner environment', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-generation-bound-');
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'temporary_retry_armed' },
    }));
    const previousGeneration = process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-origin';
    try {
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-bound',
        classification: {
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
        notify,
        reportOutboxDir: outboxDir,
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
      await removeTempDir(outboxDir);
    }
  });

  it('coalesces the same provider failure independently of legacy daemon environment changes', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'temporary_retry_armed' },
    }));
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-old';

    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'session-generation-dedupe',
      classification: classifiedFailure,
      notify,
      nowMs: () => 1_000,
    });
    process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1 = 'daemon-current';
    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'session-generation-dedupe',
      classification: classifiedFailure,
      notify,
      nowMs: () => 1_001,
    });

    expect(notify).toHaveBeenCalledOnce();
    delete process.env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
  });

  it('does not fork durable report identity for a legacy generation field', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-generation-rejection-');
    let stagedReportId: string | null = null;
    let deliveredReportId: string | null = null;
    try {
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-rejection',
        classification: classifiedFailure,
        notify: async (body) => {
          stagedReportId = body.reportId;
          throw new Error('current daemon delivery was ambiguous');
        },
        reportOutboxDir: outboxDir,
        nowMs: () => 2_000,
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'session-generation-rejection',
        classification: classifiedFailure,
        notify: async (body) => {
          deliveredReportId = body.reportId;
          return {
            ok: true,
            result: { status: 'temporary_retry_armed' },
            recoveryReceipt: {
              reportId: body.reportId,
              attemptId: 'attempt_generation_rejection',
              transition: 'scheduled',
              eventLocalId: 'event_generation_rejection',
            },
          };
        },
        reportOutboxDir: outboxDir,
        nowMs: () => 2_001,
      });

      expect(deliveredReportId).toBe(stagedReportId);
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
  beforeEach(() => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  // Incident Jun-11 H-C / FIX-2: one failed turn is observed by THREE independent triggers
  // (StopFailure hook, SDK inbound loop, bridge observeTranscript), each calling this report
  // path. Dedupe lives HERE — inside the single shared owner — keyed on stable identity only
  // (no Date.now-derived retryAfterMs), so all triggers are covered without per-call-site dedupers.
  describe('stable report dedupe', () => {
    const limitClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'leeroy_batiplus',
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
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
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
          sourceProviderAccountId: 'acct_source_one',
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_source_account',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          sourceProviderAccountId: 'acct_source_two',
        },
        notify,
        nowMs: () => 1_100,
      });

      expect(notify).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        'active profile evidence changes',
        { activeProfileId: 'primary' },
        { activeProfileId: 'backup' },
      ],
      [
        'group generation changes',
        { groupGeneration: 4 },
        { groupGeneration: 5 },
      ],
      [
        'credential health evidence changes',
        { credentialHealthStatus: 'connected' },
        { credentialHealthStatus: 'needs_reauth' },
      ],
      [
        'identity proof version changes',
        { identityProofVersion: 1 },
        { identityProofVersion: 2 },
      ],
      [
        'source relation key changes',
        { sourceKey: 'source:profile:primary' },
        { sourceKey: 'source:profile:backup' },
      ],
      [
        'provider-account usage record evidence changes',
        { providerAccountUsageRecordId: 'paug_v1_record_one' },
        { providerAccountUsageRecordId: 'paug_v1_record_two' },
      ],
    ] as const)('does not suppress reports inside the dedupe window when %s', async (_label, firstPatch, secondPatch) => {
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'noop' } }));

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_evidence_change',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          ...firstPatch,
        },
        notify,
        nowMs: () => 1_000,
      });
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_dedupe_evidence_change',
        switchesThisTurn: 0,
        classification: {
          ...limitClassification,
          ...secondPatch,
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
  });

  it('preserves typed recovery diagnostics returned by the daemon', async () => {
    const uxDiagnostic = {
      code: 'recovery_retry_scheduled',
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
      retryable: true,
      suggestedActions: ['retry'],
      diagnostics: {
        runtimeFailureKind: 'usage_limit',
        nextRetryAtMs: 1_700_000_100_000,
      },
    };
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: {
          status: 'scheduled',
          retryable: true,
          nextRetryAtMs: 1_700_000_100_000,
        },
        uxDiagnostic,
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      statusCode: 'recovery_retry_scheduled',
      statusMessage: expect.stringContaining('retry scheduled'),
      uxDiagnostic,
      projection: {
        handled: true,
        statusCode: 'recovery_retry_scheduled',
        nextRetryAtMs: 1_700_000_100_000,
        terminal: false,
        uxDiagnostic,
      },
    });
  });

  it('uses one persisted report id for direct delivery and the outbox retry after an ambiguous failure', async () => {
    const reportOutboxDir = await createTempDir('happier-runtime-auth-stable-report-id-');
    try {
      const notify = vi.fn(async () => {
        throw new Error('client timeout after daemon claim');
      });
      const scheduleOutboxDrain = vi.fn();

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_stable_report_id',
        classification: classifiedFailure,
        notify,
        reportOutboxDir,
        scheduleOutboxDrain,
        createReportId: () => 'runtime-auth-report:test-stable-id',
      });

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        reportId: 'runtime-auth-report:test-stable-id',
      }), expect.any(Object));
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir: reportOutboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]?.reportId).toBe('runtime-auth-report:test-stable-id');
      expect(scheduleOutboxDrain).toHaveBeenCalledOnce();
    } finally {
      await removeTempDir(reportOutboxDir);
    }
  });

  it('reuses a crash-staged report id for the next direct delivery after process-local dedupe is lost', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-crash-staged-report-');
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'credential_refreshed', restartRequested: true },
    }));
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          reportId: 'runtime-auth-report:before-client-crash',
          originDaemonExecutionGenerationV1: 'legacy-launcher-daemon',
          sessionId: 'sess_crash_staged',
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 1_000,
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        reportOutboxDir: outboxDir,
        sessionId: 'sess_crash_staged',
        switchesThisTurn: 0,
        classification: classifiedFailure,
        notify,
        createReportId: () => 'runtime-auth-report:after-client-restart',
        nowMs: () => 2_000,
      });

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        reportId: 'runtime-auth-report:before-client-crash',
      }), expect.anything());
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('starts a new report identity after the persisted crash-stage TTL expires', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-expired-crash-stage-');
    const notify = vi.fn(async () => ({
      ok: true,
      result: { status: 'credential_refreshed', restartRequested: true },
    }));
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          reportId: 'runtime-auth-report:expired-stage',
          sessionId: 'sess_expired_stage',
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 0,
      });

      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        reportOutboxDir: outboxDir,
        sessionId: 'sess_expired_stage',
        switchesThisTurn: 0,
        classification: classifiedFailure,
        notify,
        createReportId: () => 'runtime-auth-report:new-after-ttl',
        nowMs: () => 24 * 60 * 60_000 + 1,
      });

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        reportId: 'runtime-auth-report:new-after-ttl',
      }), expect.anything());
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('returns the daemon report and resolved status message when recovery is actionable', async () => {
    const classification = {
      kind: 'auth_expired',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'credential_refreshed',
        restartRequested: true,
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
      notify,
    })).resolves.toMatchObject({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      },
      statusCode: 'credential_refreshed_restart_requested',
      statusMessage: expect.stringContaining('refreshed'),
    });
    expect(notify).toHaveBeenCalledWith({
      reportId: expect.stringMatching(/^runtime-auth-report:/),
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
    }, {
      timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
    });
  });

  it('forwards explicit resumePromptMode through the daemon report body and exposes it to projections', async () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'codex-group',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: { status: 'scheduled', nextRetryAtMs: 1_700_000_100_000 },
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_custom_resume',
      switchesThisTurn: 0,
      classification,
      resumePromptMode: 'custom',
      notify,
    })).resolves.toMatchObject({
      handled: true,
      resumePromptMode: 'custom',
    });
    expect(notify).toHaveBeenCalledWith({
      reportId: expect.stringMatching(/^runtime-auth-report:/),
      sessionId: 'sess_custom_resume',
      switchesThisTurn: 0,
      classification,
      resumePromptMode: 'custom',
    }, {
      timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
    });
  });

  it('does not let malformed resumePromptMode values cross the daemon report boundary', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: { status: 'scheduled', nextRetryAtMs: 1_700_000_100_000 },
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_bad_resume_mode',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-group',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'stable_provider_message',
      },
      resumePromptMode: 'later',
      notify,
    })).resolves.not.toHaveProperty('resumePromptMode');
    expect(notify).toHaveBeenCalledWith(
      expect.not.objectContaining({ resumePromptMode: expect.anything() }),
      { timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS },
    );
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
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.any(Object), {
      timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
    });
  });

  it('treats typed generation apply failures as handled recovery reports', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'provider_session_state_unavailable_for_resume',
        },
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'provider_session_state_unavailable_for_resume',
          },
        },
      },
      statusCode: 'switch_attempted_generation_apply_failed',
      statusMessage: expect.stringContaining('provider_session_state_unavailable_for_resume'),
    });
  });

  it('surfaces degraded temporary-throttle recovery as a handled manual-retry projection', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'temporary_retry_unavailable',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
        retryAfterMs: 45_000,
        reason: 'manual_retry_required',
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'provider_temporary_throttle',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      statusCode: 'temporary_retry_manual_retry_required',
      statusMessage: expect.stringContaining('manual'),
      projection: {
        handled: true,
        statusCode: 'temporary_retry_manual_retry_required',
        statusMessage: expect.stringContaining('retry'),
      },
    });
  });

  it('logs and returns an unhandled result when daemon notification fails', async () => {
    const debug = vi.fn();
    const error = new Error('daemon unavailable');

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: { kind: 'unknown' },
      notify: vi.fn(async () => {
        throw error;
      }),
      logger: { debug },
      logPrefix: '[test]',
    })).resolves.toEqual({
      handled: false,
      report: null,
      statusCode: null,
      statusMessage: null,
    });
    expect(debug).toHaveBeenCalledWith(
      '[test] Failed to report connected-service runtime auth failure to daemon (non-fatal)',
      error,
    );
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
          ...classifiedFailure,
          accessToken: 'secret-access-token',
          env: { OPENAI_API_KEY: 'secret-env-value' },
          rawProviderPayload: { body: 'raw-provider-body' },
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
        classification: classifiedFailure,
        attemptCount: 1,
      });
      expect(JSON.stringify(items[0])).not.toContain('secret-access-token');
      expect(JSON.stringify(items[0])).not.toContain('secret-env-value');
      expect(JSON.stringify(items[0])).not.toContain('raw-provider-body');
      expect(scheduleOutboxDrain).toHaveBeenCalledOnce();
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('enqueues a sanitized outbox report when daemon returns an unhandled local-control error', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-unhandled-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          error: 'No daemon running, no state file found',
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          error: 'No daemon running, no state file found',
        },
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
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
          ...classifiedFailure,
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
          ...classifiedFailure,
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

  it('retains custody when daemon returns an accepted report without a matching recovery receipt', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-accepted-unprojected-');
    const scheduleOutboxDrain = vi.fn();
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          ok: true,
          result: {
            status: 'accepted_unprojected_test_status',
          },
        })),
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: true,
          result: {
            status: 'accepted_unprojected_test_status',
          },
        },
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(1);
      expect(scheduleOutboxDrain).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not treat presentation-level handled state as durable daemon custody', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-handled-without-receipt-');
    const scheduleOutboxDrain = vi.fn();
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_handled_without_receipt',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          ok: true,
          result: {
            status: 'credential_refreshed',
            restartRequested: true,
          },
        })),
        reportOutboxDir: outboxDir,
        scheduleOutboxDrain,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: true,
        statusCode: 'credential_refreshed_restart_requested',
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(1);
      expect(scheduleOutboxDrain).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('removes a matching outbox report only when daemon returns its exact custody receipt', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-clear-');
    const reportId = 'runtime-auth-report:matching-receipt';
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          ok: true,
          recoveryReceipt: {
            reportId,
            attemptId: 'runtime-auth-attempt:matching-receipt',
            transition: 'working',
            eventLocalId: 'runtime-auth-event:matching-receipt',
          },
          result: {
            status: 'credential_refreshed',
            restartRequested: true,
          },
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
        createReportId: () => reportId,
      })).resolves.toMatchObject({
        handled: true,
        statusCode: 'credential_refreshed_restart_requested',
        recoveryReceipt: { reportId },
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not remove a same-key outbox refresh that arrives during direct delivery', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-direct-refresh-');
    let releaseNotify!: () => void;
    const notifyReleased = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    let markNotifyStarted!: () => void;
    const notifyStarted = new Promise<void>((resolve) => {
      markNotifyStarted = resolve;
    });
    try {
      const direct = reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_direct_refresh',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => {
          markNotifyStarted();
          await notifyReleased;
          return {
            ok: true,
            result: { status: 'credential_refreshed', restartRequested: true },
          };
        }),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      });
      await notifyStarted;

      const refreshed = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_direct_refresh',
          switchesThisTurn: 2,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_100,
      });
      expect(refreshed).toMatchObject({ status: 'enqueued', item: { attemptCount: 2 } });

      releaseNotify();
      await expect(direct).resolves.toMatchObject({ handled: true });
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([
        expect.objectContaining({ attemptCount: 2, switchesThisTurn: 2 }),
      ]);
    } finally {
      releaseNotify?.();
      await removeTempDir(outboxDir);
    }
  });
});
