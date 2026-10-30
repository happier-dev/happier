import { describe, expect, it } from 'vitest';

import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryDiagnostic } from './RuntimeAuthRecoveryScheduler';

describe('runtime-auth credential revision recovery', () => {
  it.each(['credential_revision_missing', 'credential_revision_superseded'])(
    'retries %s apply failures through intake and recovery instead of terminalizing',
    async (errorCode) => {
      const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
      let nowMs = 1_000;
      const result = { status: 'generation_apply_failed', errorCode };
      const scheduler = new RuntimeAuthRecoveryScheduler({
        nowMs: () => nowMs,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        recover: async () => ({ status: 'switch_attempted', result }),
        recordDiagnostic: (event) => { diagnostics.push(event); },
      });
      try {
        await expect(scheduler.enqueueApplyFailure({
          sessionId: 'revision-recovery', switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit', serviceId: 'openai-codex', profileId: 'primary', groupId: 'team',
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
          },
          result,
        })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
        nowMs = 2_000;
        await expect(scheduler.wake({ sessionId: 'revision-recovery', reason: 'manual' }))
          .resolves.toEqual({ status: 'waiting' });
        expect(scheduler.read('revision-recovery')).toMatchObject({ status: 'waiting', lastError: errorCode });
        expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_terminal');
      } finally {
        scheduler.dispose();
      }
    },
  );
});
