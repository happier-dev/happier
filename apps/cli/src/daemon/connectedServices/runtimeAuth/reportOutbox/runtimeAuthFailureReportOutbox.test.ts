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

  it('coalesces duplicate report keys by updating attempt metadata', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-coalesce-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          resumePromptMode: 'custom',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 3,
          resumePromptMode: 'off',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_500,
      });

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
});
