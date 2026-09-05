import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryDiagnostic } from '../RuntimeAuthRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../../recoveryScheduler/recoveryIntentFileStore';
import { buildRuntimeAuthRecoveryKey } from '../recoveryKey/runtimeAuthRecoveryKey';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

describe('durable runtime-auth wait presentation', () => {
  it.each([null, 60_000])('publishes the actual scheduled wait with reset %s through the daemon delivery owner', async (resetsAtMs) => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-auth-projection-'));
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let delayAtMs: number | null = null;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      durableStore: createRecoveryIntentFileStore(join(directory, 'recovery.json')),
      recordDiagnostic: (event) => { diagnostics.push(event); },
      recover: async () => ({ status: 'no_eligible_member', groupExhausted: true }),
      gate: () => delayAtMs === null
        ? { status: 'open' }
        : { status: 'delayed', retryAtMs: delayAtMs, reason: 'local_server_storm' },
    });
    try {
      const classification = {
        kind: 'usage_limit' as const, serviceId: 'openai-codex' as const,
        profileId: 'only-member', groupId: 'pool', resetsAtMs,
        planType: null, rateLimits: null, source: 'structured_provider_error' as const,
      };
      const intake = await scheduler.beginClassifiedFailure({
        sessionId: 'session', switchesThisTurn: 0, classification,
      });
      const waiting = await scheduler.markDurableWaitForResultByKey({
        recoveryKey: buildRuntimeAuthRecoveryKey({ sessionId: 'session', ...classification }),
        expectedAttemptId: intake.attemptId,
        classificationResetsAtMs: resetsAtMs,
        result: { status: 'no_eligible_member', groupExhausted: true },
      });
      const projections: unknown[] = [];
      await scheduler.drainPendingVisibleEvents(async (delivery) => {
        const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: delivery.recoveryIntent });
        projections.push(updater?.({ unrelated: 'preserved' }));
      });
      expect(projections).toEqual([expect.objectContaining({
        unrelated: 'preserved',
        sessionUsageLimitRecoveryV1: expect.objectContaining({
          status: 'waiting', runtimeAuthRecoveryAttemptId: intake.attemptId,
          nextCheckAtMs: waiting?.nextRetryAtMs, resetAtMs: resetsAtMs,
          selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'pool', profileId: 'only-member' },
        }),
      })]);
      expect(waiting?.nextRetryAtMs).toBeGreaterThan(1_000);
      diagnostics.length = 0;
      await scheduler.wake({ sessionId: 'session', reason: 'manual' });
      expect(diagnostics.some((event) => event.event === 'runtime_auth_recovery_delayed' && event.transcriptEvent)).toBe(true);
      await scheduler.drainPendingVisibleEvents(async () => {
        await scheduler.markDurableWaitForResultByKey({
          recoveryKey: buildRuntimeAuthRecoveryKey({ sessionId: 'session', ...classification }),
          expectedAttemptId: intake.attemptId,
          classificationResetsAtMs: 90_000,
          result: { status: 'no_eligible_member', groupExhausted: true },
        });
      });
      expect(await scheduler.drainPendingVisibleEvents(async () => {})).toBe(1);
      delayAtMs = 120_000;
      diagnostics.length = 0;
      await scheduler.wake({ sessionId: 'session', reason: 'manual' });
      expect(diagnostics.some((event) => event.event === 'runtime_auth_recovery_delayed' && event.transcriptEvent)).toBe(true);
      const delayedProjections: unknown[] = [];
      await scheduler.drainPendingVisibleEvents(async (delivery) => {
        const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: delivery.recoveryIntent });
        delayedProjections.push(updater?.({}));
      });
      expect(delayedProjections).toEqual([expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ nextCheckAtMs: delayAtMs }),
      })]);
    } finally {
      scheduler.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
