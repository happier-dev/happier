import { describe, expect, it } from 'vitest';
import type { RuntimeAuthRecoveryIntent } from '../RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

const intent = {
  v: 2, attemptId: 'attempt-1', sessionId: 'session', serviceId: 'openai-codex',
  profileId: 'primary', groupId: 'pool', status: 'waiting', armedAtMs: 1000,
  nextRetryAtMs: 61000, attemptCount: 4, maxAttempts: 3, switchesThisTurn: 0,
  classification: { kind: 'usage_limit', serviceId: 'openai-codex', profileId: 'primary',
    groupId: 'pool', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
  failurePhase: 'handler', failureReason: 'usage_limit', lastError: 'no_eligible_member',
  lastErrorClassification: null,
} satisfies RuntimeAuthRecoveryIntent;

describe('daemon recovery intent metadata projection', () => {
  it.each(['standard', 'custom', 'off'] as const)('preserves the scheduler prompt mode %s and exact wait timing', (resumePromptMode) => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: { ...intent, resumePromptMode } });
    expect(updater?.({ unrelated: true })).toMatchObject({
      unrelated: true,
      sessionUsageLimitRecoveryV1: {
        status: 'waiting', nextCheckAtMs: 61000, resetAtMs: null,
        attemptCount: 4, runtimeAuthRecoveryAttemptId: 'attempt-1', resumePromptMode,
      },
    });
  });
  it.each(['cancelled', 'exhausted', 'recovered'] as const)('projects terminal %s without a wake', (status) => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: { ...intent, status } });
    expect(updater?.({})).toMatchObject({
      sessionUsageLimitRecoveryV1: { status: status === 'recovered' ? 'paused' : status, nextCheckAtMs: null },
    });
  });
  it('does not rewrite a newer recovery or undo cancellation of the same attempt', () => {
    const project = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent })!;
    const newer = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      intent: { ...intent, attemptId: 'newer', armedAtMs: 2000 },
    })!({});
    expect(project(newer)).toBe(newer);
    const cancelled = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent: { ...intent, status: 'cancelled' } })!({});
    expect(project(cancelled)).toBe(cancelled);
  });
  it('does not turn an authentication failure into a usage-limit wait', () => {
    expect(buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      intent: { ...intent, classification: { ...intent.classification, kind: 'auth_expired' } },
    })).toBeNull();
  });
  it('preserves observed reset credits for the same recovery attempt, but not a replacement', () => {
    const project = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({ intent })!;
    const initial = project({});
    const recoveryCredits = {
      kind: 'usage_limit_resets', availableCount: 1, totalCount: 1,
      source: 'provider_api', confidence: 'exact', credits: [],
    };
    const existing = { sessionUsageLimitRecoveryV1: {
      ...(initial.sessionUsageLimitRecoveryV1 as Record<string, unknown>), recoveryCredits,
    } };
    expect(project(existing)).toMatchObject({ sessionUsageLimitRecoveryV1: { recoveryCredits } });
    const replacement = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      intent: { ...intent, attemptId: 'replacement', armedAtMs: 2000 },
    })!(existing);
    expect(replacement.sessionUsageLimitRecoveryV1).not.toHaveProperty('recoveryCredits');
  });
});
