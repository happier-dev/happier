import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  drainRuntimeAuthFailureReportOutboxItems,
  enqueueRuntimeAuthFailureReportOutboxItem,
  readRuntimeAuthFailureReportOutboxItems,
  removeRuntimeAuthFailureReportOutboxItem,
  removeRuntimeAuthFailureReportOutboxItemsForSession,
} from './runtimeAuthFailureReportOutbox';

const classifiedFailure = {
  kind: 'usage_limit',
  limitCategory: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'codex-group',
  resetsAtMs: 1_700_000_100_000,
  retryAfterMs: 60_000,
  quotaScope: 'account',
  providerLimitId: 'codex-daily-limit',
  sourceProviderAccountId: 'acct_source',
  sourceAccountLabel: 'source@example.test',
  groupGeneration: 42,
  action: { kind: 'open_url', url: 'https://provider.example/reconnect' },
  planType: 'team',
  rateLimits: {
    accessToken: 'secret-rate-limit-token',
  },
  source: 'structured_provider_error',
  accessToken: 'secret-access-token',
  refresh_token: 'secret-refresh-token',
  env: { OPENAI_API_KEY: 'secret-env-value' },
  rawCredentialBody: { password: 'secret-password' },
  rawProviderPayload: { body: 'raw-provider-body' },
} as const;

describe('runtimeAuthFailureReportOutbox', () => {
  it('keeps reports from different credential revisions independently durable', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-outbox-revision-');
    try {
      for (const expectedCredentialRevision of [
        'csr_abcdefghijklmnopqrstuv',
        'csr_bcdefghijklmnopqrstuvw',
      ] as const) {
        await enqueueRuntimeAuthFailureReportOutboxItem({
          outboxDir,
          report: {
            sessionId: 'session-revision',
            classification: { ...classifiedFailure, expectedCredentialRevision },
          },
        });
      }
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(2);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
  it('persists one stable report id across repeated refresh attempts', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-outbox-report-id-');
    try {
      const report = {
        reportId: 'runtime-auth-report:stable-1',
        originDaemonExecutionGenerationV1: 'legacy-launcher-daemon',
        sessionId: 'session-report-id',
        classification: classifiedFailure,
      } as const;
      const first = await enqueueRuntimeAuthFailureReportOutboxItem({ outboxDir, report, nowMs: () => 1 });
      const second = await enqueueRuntimeAuthFailureReportOutboxItem({ outboxDir, report, nowMs: () => 2 });

      expect(first).toMatchObject({ status: 'enqueued', item: { reportId: report.reportId, attemptCount: 1 } });
      expect(second).toMatchObject({ status: 'enqueued', item: { reportId: report.reportId, attemptCount: 2 } });
    } finally {
      await removeTempDir(outboxDir);
    }
  });
  it('ignores a legacy daemon-generation field when coalescing one durable failure', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-outbox-generation-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        nowMs: () => 1_000,
        report: {
          originDaemonExecutionGenerationV1: 'daemon-old',
          sessionId: 'session-generation',
          classification: classifiedFailure,
        },
      });
      const current = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        nowMs: () => 1_001,
        report: {
          originDaemonExecutionGenerationV1: 'daemon-current',
          sessionId: 'session-generation',
          classification: classifiedFailure,
        },
      });
      expect(current).toMatchObject({
        status: 'enqueued',
        enqueue: 'coalesced',
        item: {
          attemptCount: 2,
          createdAtMs: 1_000,
        },
      });
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).not.toHaveProperty('originDaemonExecutionGenerationV1');
    } finally {
      await removeTempDir(outboxDir);
    }
  });
  it('stores only sanitized non-secret report fields', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-');
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          resumePromptMode: 'custom',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });

      expect(result).toMatchObject({ status: 'enqueued' });
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        resumePromptMode: 'custom',
        classification: {
          kind: 'usage_limit',
          limitCategory: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-group',
          resetsAtMs: 1_700_000_100_000,
          retryAfterMs: 60_000,
          quotaScope: 'account',
          providerLimitId: 'codex-daily-limit',
          sourceProviderAccountId: 'acct_source',
          sourceAccountLabel: 'source@example.test',
          groupGeneration: 42,
          action: { kind: 'open_url', url: 'https://provider.example/reconnect' },
          planType: 'team',
          rateLimits: null,
          source: 'structured_provider_error',
        },
        attemptCount: 1,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      });

      const raw = await readFile(join(outboxDir, `${items[0].fileId}.json`), 'utf8');
      expect(raw).not.toContain('secret-access-token');
      expect(raw).not.toContain('secret-refresh-token');
      expect(raw).not.toContain('secret-rate-limit-token');
      expect(raw).not.toContain('secret-env-value');
      expect(raw).not.toContain('secret-password');
      expect(raw).not.toContain('raw-provider-body');
      expect(raw).not.toContain('OPENAI_API_KEY');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('normalizes deferred reports with the shared runtime-auth classification sanitizer', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-shared-sanitizer-');
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_shared_sanitizer',
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'codex-group',
            resetsAtMs: 1_700_000_100_000,
            retryAfterMs: 60_000,
            planType: 'team',
            connectedServiceRecovery: 'available',
            sourceProviderAccountId: 'acct_source',
            sourceAccountLabel: 'source@example.test',
            groupGeneration: 42,
            rateLimits: {
              limitCategory: 'usage_limit',
              quotaScope: 'workspace',
              providerLimitId: 'codex-daily-limit',
              action: { kind: 'open_url', url: 'https://provider.example/reconnect' },
              accessToken: 'secret-rate-limit-token',
            },
            source: 'structured_provider_error',
          },
        },
        nowMs: () => 1_700_000_000_000,
      });

      expect(result).toMatchObject({ status: 'enqueued' });
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0].classification).toEqual(expect.objectContaining({
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
        resetsAtMs: 1_700_000_100_000,
        retryAfterMs: 60_000,
        quotaScope: 'workspace',
        providerLimitId: 'codex-daily-limit',
        action: { kind: 'open_url', url: 'https://provider.example/reconnect' },
        planType: 'team',
        connectedServiceRecovery: 'available',
        rateLimits: null,
        source: 'structured_provider_error',
        sourceProviderAccountId: 'acct_source',
        sourceAccountLabel: 'source@example.test',
        groupGeneration: 42,
      }));

      const raw = await readFile(join(outboxDir, `${items[0].fileId}.json`), 'utf8');
      expect(raw).not.toContain('secret-rate-limit-token');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('coalesces duplicate report keys by updating attempt metadata', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-coalesce-');
    try {
      const first = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          resumePromptMode: 'custom',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const second = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 3,
          resumePromptMode: 'off',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_500,
      });

      expect(first).toMatchObject({ status: 'enqueued', enqueue: 'accepted' });
      expect(second).toMatchObject({ status: 'enqueued', enqueue: 'coalesced' });

      const canonicalFiles = (await readdir(outboxDir)).filter((entry) => entry.endsWith('.json'));
      expect(canonicalFiles).toHaveLength(1);
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        switchesThisTurn: 3,
        resumePromptMode: 'off',
        attemptCount: 2,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_500,
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('quarantines invalid JSON while listing reports', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-invalid-');
    try {
      await mkdir(outboxDir, { recursive: true });
      await writeFile(join(outboxDir, 'report-invalid.json'), '{ invalid json', 'utf8');

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([]);
      const quarantineFiles = await readdir(join(outboxDir, 'quarantine'));
      expect(quarantineFiles.some((entry) => entry.includes('report-invalid'))).toBe(true);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('removes delivered reports by report key', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-remove-');
    try {
      const result = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      expect(result.status).toBe('enqueued');
      if (result.status !== 'enqueued') {
        throw new Error('expected report to be enqueued');
      }

      await removeRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        reportKey: result.item.reportKey,
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('drains delivered reports and keeps retryable reports', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-drain-');
    try {
      const delivered = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_delivered',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      const retryable = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_retry',
          switchesThisTurn: 1,
          classification: {
            ...classifiedFailure,
            profileId: 'secondary',
          },
        },
        nowMs: () => 1_700_000_000_100,
      });
      expect(delivered.status).toBe('enqueued');
      expect(retryable.status).toBe('enqueued');

      const result = await drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        deliver: async (item) => item.sessionId === 'sess_delivered'
          ? { status: 'delivered' as const }
          : { status: 'retry' as const },
      });

      expect(result).toEqual({ delivered: 1, dropped: 0, retried: 1 });
      const remaining = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('sess_retry');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not remove a same-key report refreshed while an older delivery is in flight', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-refresh-race-');
    let releaseDelivery!: () => void;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_refresh_race',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });

      const drain = drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        deliver: async () => {
          markDeliveryStarted();
          await deliveryReleased;
          return { status: 'delivered' as const };
        },
      });
      await deliveryStarted;

      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_refresh_race',
          switchesThisTurn: 2,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_200,
      });

      releaseDelivery();
      await expect(drain).resolves.toEqual({ delivered: 1, dropped: 0, retried: 0 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([
        expect.objectContaining({
          sessionId: 'sess_refresh_race',
          switchesThisTurn: 2,
          attemptCount: 2,
        }),
      ]);
    } finally {
      releaseDelivery?.();
      await removeTempDir(outboxDir);
    }
  });

  it('drops stale reports when the drain owner marks them superseded', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-drop-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_stale',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });

      const result = await drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        deliver: async () => ({ status: 'drop' as const }),
      });

      expect(result).toEqual({ delivered: 0, dropped: 1, retried: 0 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('removes all reports for a manually superseded session without touching other sessions', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-remove-session-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_superseded',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_other',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_100,
      });

      await removeRuntimeAuthFailureReportOutboxItemsForSession({
        outboxDir,
        sessionId: 'sess_superseded',
      });

      const remaining = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('sess_other');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('preserves reports created after a lifecycle supersession boundary', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-boundary-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_superseded',
          switchesThisTurn: 1,
          classification: {
            ...classifiedFailure,
            expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
          },
        },
        nowMs: () => 100,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_superseded',
          switchesThisTurn: 1,
          classification: {
            ...classifiedFailure,
            expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
          },
        },
        nowMs: () => 300,
      });

      await removeRuntimeAuthFailureReportOutboxItemsForSession({
        outboxDir,
        sessionId: 'sess_superseded',
        updatedBeforeMs: 200,
      });

      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([
        expect.objectContaining({
          sessionId: 'sess_superseded',
          updatedAtMs: 300,
          classification: expect.objectContaining({
            expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
          }),
        }),
      ]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
});
