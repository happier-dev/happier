import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { enqueueRuntimeAuthFailureReportOutboxItem, readRuntimeAuthFailureReportOutboxItems } from './runtimeAuthFailureReportOutbox';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';

const classifiedFailure = {
  kind: 'auth_expired',
  serviceId: 'claude-subscription',
  profileId: 'leeroy_new',
  groupId: 'claude-group',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as const;

describe('runtimeAuthFailureReportOutboxDrain', () => {
  it('drains a persisted old-generation item without forwarding launcher-daemon authority', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-legacy-generation-');
    const reportKey = 'runtime-auth-failure-report:v1:legacy-generation-key';
    const fileId = `report-${createHash('sha256').update(reportKey).digest('base64url').slice(0, 32)}`;
    try {
      await writeFile(join(outboxDir, `${fileId}.json`), JSON.stringify({
        schemaVersion: 1,
        fileId,
        reportKey,
        reportId: 'runtime-auth-report:legacy-generation-report',
        originDaemonExecutionGenerationV1: 'daemon-before-replacement',
        sessionId: 'sess_legacy_generation',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        attemptCount: 1,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      }));
      const notify = vi.fn(async (body: Readonly<{ reportId: string }>) => ({
        ok: true,
        result: { status: 'credential_refreshed' },
        recoveryReceipt: {
          reportId: body.reportId,
          attemptId: 'attempt_legacy_generation',
        },
      }));

      await expect(drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify })).resolves.toEqual({
        delivered: 1,
        dropped: 0,
        retried: 0,
      });
      expect(notify).toHaveBeenCalledWith(expect.not.objectContaining({
        originDaemonExecutionGenerationV1: expect.anything(),
      }));
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('replays reports through daemon runtime-auth intake and removes accepted items', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-daemon-drain-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_group_401',
          switchesThisTurn: 2,
          resumePromptMode: 'custom',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const notify = vi.fn(async (body: Readonly<{ reportId: string }>) => ({
        ok: true,
        result: { status: 'credential_refreshed' },
        recoveryReceipt: {
          reportId: body.reportId,
          attemptId: 'attempt_group_401',
        },
      }));

      const result = await drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify });

      expect(result).toEqual({ delivered: 1, dropped: 0, retried: 0 });
      expect(notify).toHaveBeenCalledWith({
        reportId: expect.stringMatching(/^runtime-auth-report:/),
        sessionId: 'sess_group_401',
        switchesThisTurn: 2,
        resumePromptMode: 'custom',
        classification: expect.objectContaining({
          kind: 'auth_expired',
          serviceId: 'claude-subscription',
          profileId: 'leeroy_new',
          groupId: 'claude-group',
        }),
      });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('retains an accepted-looking report until the daemon returns the matching custody receipt', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-daemon-unreceipted-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_unreceipted',
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const notify = vi.fn(async () => ({
        ok: true,
        result: { status: 'credential_refreshed' },
      }));

      await expect(drainRuntimeAuthFailureReportOutboxToDaemon({
        outboxDir,
        notify,
      })).resolves.toEqual({
        delivered: 0,
        dropped: 0,
        retried: 1,
      });
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it.each([
    'temporary_retry_armed',
    'temporary_retry_unavailable',
  ] as const)('drops a report after the dedicated temporary-retry owner returns %s', async (status) => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-temporary-retry-owner-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: `sess_${status}`,
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const notify = vi.fn(async () => ({
        ok: true,
        result: { status },
      }));

      await expect(drainRuntimeAuthFailureReportOutboxToDaemon({
        outboxDir,
        notify,
      })).resolves.toEqual({
        delivered: 0,
        dropped: 1,
        retried: 0,
      });
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('keeps reports when daemon runtime-auth intake is unavailable', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-daemon-retry-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_retry',
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const notify = vi.fn(async () => ({
        ok: false,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed',
      }));

      const result = await drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify });

      expect(result).toEqual({ delivered: 0, dropped: 0, retried: 1 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('keeps reports when daemon shutdown defers runtime-auth intake', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-daemon-shutdown-retry-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_shutdown_retry',
          switchesThisTurn: 0,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const notify = vi.fn(async () => ({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      }));

      const result = await drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify });

      expect(result).toEqual({ delivered: 0, dropped: 0, retried: 1 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
});
