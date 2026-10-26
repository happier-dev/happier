import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import { resolveInactiveUsageLimitRecoverySchedulerResult } from './connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';

function recoveryMetadata(status: 'paused' | 'cancelled'): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
      v: 1,
      status,
      issueFingerprint: 'usage-limit:codex:turn-1:1:2',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: null,
      attemptCount: 1,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    },
  };
}

describe('startDaemon usage-limit recovery composition', () => {
  it('keeps startup provider-ready passive and reserves scheduler success for a completed resume', async () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: {
        ok: true,
        status: 'ready',
        metadata: recoveryMetadata('paused'),
      },
      nowMs: 1,
      fallbackRetryDelayMs: 1_000,
    })).toEqual({
      status: 'pause',
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    });

    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: {
        ok: true,
        status: 'resumed',
        metadata: recoveryMetadata('cancelled'),
      },
      nowMs: 1,
      fallbackRetryDelayMs: 1_000,
    })).toEqual({
      status: 'resumed',
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    });

    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');
    const hydrationStart = source.indexOf('hydrateInactiveUsageLimitRecoveryFromSessionMetadata({');
    expect(hydrationStart).toBeGreaterThanOrEqual(0);
    const hydrationEnd = source.indexOf('}).then((result)', hydrationStart);
    const hydrationComposition = source.slice(hydrationStart, hydrationEnd);
    expect(hydrationComposition).toContain('observe: ({ sessionId, recovery, runCheckNow })');
    expect(hydrationComposition).toContain('inactiveUsageLimitRecoveryCheckOwner.schedule({');
    expect(hydrationComposition).not.toContain('inactiveUsageLimitRecoveryScheduler.upsert');
    expect(hydrationComposition).not.toContain('resumeInactiveSessionWhenReady');

    expect(source).toContain('inactiveUsageLimitRecoveryScheduler.hydratePassive()');
    expect(source).not.toContain('inactiveUsageLimitRecoveryScheduler.hydrate();');
    expect(source).toContain('createRuntimeAuthRecoverySchedulerForDaemon({');
    expect(source).toContain('runtimeAuthRecoveryComposition.hydratedIntents');
    expect(source).toContain('resolveInactiveUsageLimitRecoverySchedulerResult({');
    expect(source).toContain('resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata, readiness })');
  });
});
