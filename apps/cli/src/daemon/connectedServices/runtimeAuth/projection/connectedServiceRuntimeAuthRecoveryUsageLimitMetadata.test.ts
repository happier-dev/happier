import { describe, expect, it } from 'vitest';
import type { RuntimeAuthRecoveryIntent } from '../RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthUsageLimitRecoveryProjection } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

const intent = {
  v: 1, attemptId: 'attempt-1', sessionId: 'session', serviceId: 'happier.agent.codex/openai-codex',
  profileId: 'primary', groupId: 'pool', status: 'waiting', armedAtMs: 1000,
  nextRetryAtMs: 61000, attemptCount: 4, maxAttempts: 3, switchesThisTurn: 0,
  classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary',
    groupId: 'pool', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
  failurePhase: 'handler', failureReason: 'usage_limit', lastError: 'no_eligible_member',
  lastErrorClassification: null,
} satisfies RuntimeAuthRecoveryIntent;

describe('daemon recovery intent metadata projection', () => {
  it('projects a pool wait whose failing member is unknown', () => {
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({ ...intent, profileId: null,
      classification: { ...intent.classification, profileId: null } })).toMatchObject({
      runtimeAuthRecoveryAttemptId: 'attempt-1', selectedAuth: {
        kind: 'group', serviceId: intent.serviceId, groupId: 'pool', profileId: null,
      },
    });
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({ ...intent, profileId: null, groupId: null })).toBeNull();
  });
  it('projects the actual failure fingerprint separately from its runtime attempt', () => {
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({
      ...intent, classification: { ...intent.classification, runtimeIssueFingerprint: 'usage-limit:codex:turn-b:2000:5000' },
    })).toMatchObject({
      issueFingerprint: 'usage-limit:codex:turn-b:2000:5000', runtimeAuthRecoveryAttemptId: 'attempt-1',
    });
  });

  it.each(['standard', 'custom', 'off'] as const)('preserves the scheduler prompt mode %s and exact wait timing', (resumePromptMode) => {
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({ ...intent, resumePromptMode })).toMatchObject({
        status: 'waiting', nextCheckAtMs: 61000, resetAtMs: null,
        attemptCount: 4, runtimeAuthRecoveryAttemptId: 'attempt-1', resumePromptMode,
    });
  });
  it.each(['cancelled', 'exhausted', 'recovered'] as const)('projects terminal %s without a wake', (status) => {
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({ ...intent, status })).toMatchObject({
      status: status === 'recovered' ? 'paused' : status, nextCheckAtMs: null,
    });
  });
  it('does not turn an authentication failure into a usage-limit wait', () => {
    expect(buildRuntimeAuthUsageLimitRecoveryProjection({
      ...intent, classification: { ...intent.classification, kind: 'auth_expired' },
    })).toBeNull();
  });
});
