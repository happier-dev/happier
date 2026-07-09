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
      const notify = vi.fn(async () => ({ ok: true, result: { status: 'credential_refreshed' } }));

      const result = await drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify });

      expect(result).toEqual({ delivered: 1, dropped: 0, retried: 0 });
      expect(notify).toHaveBeenCalledWith({
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
