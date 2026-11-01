import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
  sourceProviderAccountId: 'acct-source',
  sourceProviderOrganizationId: 'org-source',
  sourceAccountLabel: 'source@example.test',
  failingAccessTokenFingerprint: 'sha256:abcdef12',
  accessToken: 'secret-access-token',
  refresh_token: 'secret-refresh-token',
  env: { OPENAI_API_KEY: 'secret-env-value' },
  rawCredentialBody: { password: 'secret-password' },
  rawProviderPayload: { body: 'raw-provider-body' },
} as const;

async function waitForReadyFiles(barrierDir: string, expected: number): Promise<void> {
  // Six fresh TSX child processes can take more than ten seconds to initialize on a busy
  // validation host; the barrier tests concurrency, not startup latency.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const readyCount = (await readdir(barrierDir)).filter((entry) => entry.startsWith('ready-')).length;
    if (readyCount === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runtime_auth_failure_report_outbox_child_barrier_timeout');
}

async function runEnqueueChild(params: Readonly<{
  outboxDir: string;
  barrierDir: string;
  childId: string;
}>): Promise<string> {
  const fixturePath = fileURLToPath(new URL(
    './fixtures/enqueueRuntimeAuthFailureReportOutboxChild.ts',
    import.meta.url,
  ));
  const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, params.outboxDir, params.barrierDir, params.childId], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`enqueue child ${params.childId} failed (${exitCode}): ${stderr}`);
  return stdout.trim();
}

describe('runtimeAuthFailureReportOutbox', () => {
  it('ignores a legacy daemon-generation field when coalescing one durable failure', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-outbox-generation-');
    try {
      const first = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        nowMs: () => 1_000,
        report: {
          reportId: 'runtime-auth-report:old-generation',
          originDaemonExecutionGenerationV1: 'daemon-old',
          sessionId: 'session-generation',
          classification: classifiedFailure,
        },
      });
      const second = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        nowMs: () => 1_001,
        report: {
          reportId: 'runtime-auth-report:current-generation',
          originDaemonExecutionGenerationV1: 'daemon-current',
          sessionId: 'session-generation',
          classification: classifiedFailure,
        },
      });

      expect(first).toMatchObject({ status: 'enqueued' });
      expect(second).toMatchObject({
        status: 'enqueued',
        item: {
          reportId: 'runtime-auth-report:old-generation',
          attemptCount: 2,
          createdAtMs: 1_000,
        },
      });
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toEqual([
        expect.objectContaining({
          reportId: 'runtime-auth-report:old-generation',
          attemptCount: 2,
        }),
      ]);
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
        reportId: expect.stringMatching(/^runtime-auth-report:/),
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
          sourceProviderAccountId: 'acct-source',
          sourceProviderOrganizationId: 'org-source',
          sourceAccountLabel: 'source@example.test',
          failingAccessTokenFingerprint: 'sha256:abcdef12',
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
      const first = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          resumePromptMode: 'standard',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 3,
          resumePromptMode: 'custom',
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_500,
      });

      const canonicalFiles = (await readdir(outboxDir)).filter((entry) => entry.endsWith('.json'));
      expect(canonicalFiles).toHaveLength(1);
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        reportId: first.status === 'enqueued' ? first.item.reportId : undefined,
        switchesThisTurn: 3,
        resumePromptMode: 'custom',
        attemptCount: 2,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_500,
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not coalesce otherwise identical reports from different credential revisions', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-revision-');
    try {
      for (const credentialRevision of ['csr_aaaaaaaaaaaaaaaaaaaaaa', 'csr_bbbbbbbbbbbbbbbbbbbbbb']) {
        await enqueueRuntimeAuthFailureReportOutboxItem({
          outboxDir,
          report: {
            sessionId: 'sess_revision',
            classification: { ...classifiedFailure, credentialRevision },
          },
          nowMs: () => 1_700_000_000_000,
        });
      }
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(2);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('allocates one report id when concurrent writers enqueue the same stable key', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-concurrent-');
    try {
      const results = await Promise.all(Array.from({ length: 20 }, async () => (
        await enqueueRuntimeAuthFailureReportOutboxItem({
          outboxDir,
          report: {
            sessionId: 'sess_concurrent',
            switchesThisTurn: 1,
            classification: classifiedFailure,
          },
          nowMs: () => 1_700_000_000_000,
        })
      )));

      const reportIds = new Set(results.flatMap((result) => (
        result.status === 'enqueued' ? [result.item.reportId] : []
      )));
      expect(results.every((result) => result.status === 'enqueued')).toBe(true);
      expect(reportIds.size).toBe(1);
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(1);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('allocates one report id across child processes released at the same barrier', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-processes-');
    const barrierDir = await createTempDir('happier-runtime-auth-report-outbox-barrier-');
    try {
      const childCount = 6;
      const children = Array.from({ length: childCount }, (_, index) => runEnqueueChild({
        outboxDir,
        barrierDir,
        childId: String(index),
      }));
      await waitForReadyFiles(barrierDir, childCount);
      await writeFile(join(barrierDir, 'go'), '', 'utf8');
      const reportIds = new Set(await Promise.all(children));

      expect(reportIds.size).toBe(1);
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(1);
    } finally {
      await removeTempDir(outboxDir);
      await removeTempDir(barrierDir);
    }
  }, 45_000);

  it('coalesces unchanged evidence even when retryAfterMs jitters between retries', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-stable-key-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 2,
          classification: {
            ...classifiedFailure,
            retryAfterMs: 30_000,
          },
        },
        nowMs: () => 1_700_000_000_500,
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        switchesThisTurn: 2,
        attemptCount: 2,
      });
    } finally {
      await removeTempDir(outboxDir);
    }
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
  ] as const)('does not coalesce retry state when %s', async (_label, firstPatch, secondPatch) => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-evidence-change-');
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: {
            ...classifiedFailure,
            ...firstPatch,
          },
        },
        nowMs: () => 1_700_000_000_000,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_1',
          switchesThisTurn: 2,
          classification: {
            ...classifiedFailure,
            ...secondPatch,
          },
        },
        nowMs: () => 1_700_000_000_500,
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(2);
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

  it('keeps removal idempotent when the outbox directory does not exist', async () => {
    const parentDir = await createTempDir('happier-runtime-auth-report-outbox-missing-');
    const outboxDir = join(parentDir, 'not-created');
    try {
      await expect(removeRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        reportKey: 'runtime-auth-failure-report:v1:missing',
      })).resolves.toBeUndefined();
    } finally {
      await removeTempDir(parentDir);
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
        nowMs: () => 1_700_000_000_200,
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
      const original = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_refresh_race',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_000,
      });
      expect(original.status).toBe('enqueued');

      const drain = drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        nowMs: () => 1_700_000_000_100,
        deliver: async () => {
          markDeliveryStarted();
          await deliveryReleased;
          return { status: 'delivered' as const };
        },
      });
      await deliveryStarted;

      const refreshed = await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_refresh_race',
          switchesThisTurn: 2,
          classification: classifiedFailure,
        },
        nowMs: () => 1_700_000_000_200,
      });
      expect(refreshed).toMatchObject({
        status: 'enqueued',
        item: {
          attemptCount: 2,
          switchesThisTurn: 2,
        },
      });

      releaseDelivery();
      await expect(drain).resolves.toEqual({ delivered: 1, dropped: 0, retried: 0 });
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toEqual([
        expect.objectContaining({
          reportId: refreshed.status === 'enqueued' ? refreshed.item.reportId : '',
          attemptCount: 2,
          switchesThisTurn: 2,
          updatedAtMs: 1_700_000_000_200,
        }),
      ]);
    } finally {
      releaseDelivery?.();
      await removeTempDir(outboxDir);
    }
  });

  it('drops reports past the TTL at drain time instead of redelivering them forever (RD-REC-6)', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-ttl-');
    try {
      const enqueueAtMs = 1_700_000_000_000;
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_expired',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => enqueueAtMs,
      });
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_fresh',
          switchesThisTurn: 1,
          classification: {
            ...classifiedFailure,
            profileId: 'secondary',
          },
        },
        nowMs: () => enqueueAtMs + 60_000,
      });

      const deliveredSessionIds: string[] = [];
      const result = await drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        nowMs: () => enqueueAtMs + 60_000 + 1,
        maxItemAgeMs: 60_000,
        deliver: async (item) => {
          deliveredSessionIds.push(item.sessionId);
          return { status: 'delivered' as const };
        },
      });

      // The expired item is dropped WITHOUT a delivery attempt; the fresh one delivers.
      expect(deliveredSessionIds).toEqual(['sess_fresh']);
      expect(result).toEqual({ delivered: 1, dropped: 1, retried: 0 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('redelivers a re-observed report whose original enqueue is past the TTL (updatedAtMs is the freshness anchor)', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-ttl-reobserved-');
    try {
      const enqueueAtMs = 1_700_000_000_000;
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_reobserved',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => enqueueAtMs,
      });
      // Same report key observed again much later: the failure is still current.
      await enqueueRuntimeAuthFailureReportOutboxItem({
        outboxDir,
        report: {
          sessionId: 'sess_reobserved',
          switchesThisTurn: 1,
          classification: classifiedFailure,
        },
        nowMs: () => enqueueAtMs + 10 * 60_000,
      });

      const result = await drainRuntimeAuthFailureReportOutboxItems({
        outboxDir,
        nowMs: () => enqueueAtMs + 10 * 60_000 + 1_000,
        maxItemAgeMs: 60_000,
        deliver: async () => ({ status: 'delivered' as const }),
      });

      expect(result).toEqual({ delivered: 1, dropped: 0, retried: 0 });
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
        nowMs: () => 1_700_000_000_100,
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
