import { describe, expect, it } from 'vitest';

import {
  SessionUsageLimitRecoveryV1Schema,
  resolveSessionUsageLimitRecoveryResumePromptModeV1,
  buildUsageLimitIssueFingerprint,
  isSessionUsageLimitRecoveryForIssue,
  isSessionUsageLimitRecoveryInProgressV1,
  readSessionUsageLimitRecoveryForIssue,
} from './sessionUsageLimitRecoveryV1.js';
import type { SessionRuntimeIssueV1 } from '../sessions/control/runtimeIssueV1.js';

const baseIntent = {
  v: 1,
  status: 'waiting',
  issueFingerprint: 'usage-limit:sess_1:reset',
  armedAtMs: 1,
  resetAtMs: 2,
  nextCheckAtMs: 2,
  attemptCount: 0,
  maxAttempts: 3,
  lastProbeError: null,
  selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
} as const;

describe('SessionUsageLimitRecoveryV1', () => {
  it('reads a recovery as in progress only while it is armed, waiting, or checking', () => {
    for (const status of ['armed', 'waiting', 'checking'] as const) {
      expect(isSessionUsageLimitRecoveryInProgressV1({ sessionUsageLimitRecoveryV1: { ...baseIntent, status } })).toBe(true);
    }
    for (const status of ['paused', 'exhausted', 'cancelled'] as const) {
      expect(isSessionUsageLimitRecoveryInProgressV1({ sessionUsageLimitRecoveryV1: { ...baseIntent, status } })).toBe(false);
    }
    expect(isSessionUsageLimitRecoveryInProgressV1(null)).toBe(false);
    expect(isSessionUsageLimitRecoveryInProgressV1({ sessionUsageLimitRecoveryV1: { ...baseIntent, status: 'unknown' } })).toBe(false);
  });

  it('uses the same exact issue identity for recovery producers and readers', () => {
    const issue: SessionRuntimeIssueV1 = {
      v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit',
      provider: 'claude', providerTurnId: 'turn-b', occurredAt: 2_000,
      usageLimit: { v: 1, resetAtMs: 5_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
    };
    const recovery = { issueFingerprint: buildUsageLimitIssueFingerprint(issue) };
    expect(recovery.issueFingerprint).toBe('usage-limit:claude:turn-b:2000:5000');
    expect(isSessionUsageLimitRecoveryForIssue(issue, recovery)).toBe(true);
    expect(isSessionUsageLimitRecoveryForIssue({ ...issue, occurredAt: 2_001 }, recovery)).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue(issue, { issueFingerprint: 'opaque-attempt' })).toBe(false);
    const intent = { ...baseIntent, issueFingerprint: recovery.issueFingerprint };
    expect(readSessionUsageLimitRecoveryForIssue(intent, issue)?.issueFingerprint).toBe(recovery.issueFingerprint);
    expect(readSessionUsageLimitRecoveryForIssue(intent, { ...issue, occurredAt: 2_001 })).toBeNull();
    expect(readSessionUsageLimitRecoveryForIssue(intent)?.issueFingerprint).toBe(recovery.issueFingerprint);
    const providerless = { ...issue, provider: undefined, providerTurnId: undefined, usageLimit: undefined };
    expect(buildUsageLimitIssueFingerprint(providerless)).toBe('usage-limit:unknown-provider:unknown-turn:2000:no-reset');
    expect(buildUsageLimitIssueFingerprint(providerless, 'claude')).toBe('usage-limit:claude:unknown-turn:2000:no-reset');
  });

  it('associates the historical two-producer failure without inheriting another turn or auth source', () => {
    const first: SessionRuntimeIssueV1 = {
      v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit',
      provider: 'claude', occurredAt: 1793871333659,
      usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
        connectedService: { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'primary' } },
    };
    const enriched = { ...first, occurredAt: 1793871333704, usageLimit: { ...first.usageLimit!, resetAtMs: 1794283200000 } };
    const recovery = { ...baseIntent, issueFingerprint: buildUsageLimitIssueFingerprint(first),
      armedAtMs: 1793871335690, runtimeAuthRecoveryAttemptId: 'attempt-1',
      selectedAuth: { kind: 'group', serviceId: 'claude-subscription', groupId: 'pool', profileId: 'primary' } } as const;
    expect(isSessionUsageLimitRecoveryForIssue(enriched, recovery)).toBe(true);
    expect(readSessionUsageLimitRecoveryForIssue(recovery, enriched)?.runtimeAuthRecoveryAttemptId).toBe('attempt-1');
    expect(isSessionUsageLimitRecoveryForIssue({ ...enriched, occurredAt: recovery.armedAtMs + 1 }, recovery)).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue({ ...enriched, provider: 'codex' }, recovery)).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue(enriched, { ...recovery, status: 'cancelled' })).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue(enriched, { ...recovery, runtimeAuthRecoveryAttemptId: undefined })).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue(enriched, { ...recovery, issueFingerprint: 'attempt-1' })).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue({ ...enriched, usageLimit: { ...enriched.usageLimit,
      connectedService: { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'other' } } }, recovery)).toBe(false);
    expect(isSessionUsageLimitRecoveryForIssue({ ...enriched, providerTurnId: 'new-turn' }, {
      ...recovery, issueFingerprint: buildUsageLimitIssueFingerprint({ ...first, providerTurnId: 'failed-turn' }),
    })).toBe(false);
  });

  it('defaults and persists resumePromptMode on stored recovery intents', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse(baseIntent)).toMatchObject({
      resumePromptMode: 'standard',
    });
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      resumePromptMode: 'off',
    })).toMatchObject({
      resumePromptMode: 'off',
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse({
      ...baseIntent,
      resumePromptMode: 'sometimes',
    }).success).toBe(false);
  });

  it('preserves the exact runtime-auth recovery attempt identity when projected', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).toMatchObject({
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('accepts group recovery auth selections without a known profile id', () => {
    expect(SessionUsageLimitRecoveryV1Schema.safeParse({
      ...baseIntent,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: null,
      },
    }).success).toBe(true);
  });

  it('accepts generalized recovery-credit inventory on stored recovery intents', () => {
    expect(SessionUsageLimitRecoveryV1Schema.parse({
      ...baseIntent,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        nextExpiresAtMs: 1_701_000_000_000,
        source: 'provider_api',
        confidence: 'exact',
        credits: [{
          providerCreditId: 'reset-credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
          grantedAtMs: 1_699_000_000_000,
          expiresAtMs: 1_701_000_000_000,
          redeemedAtMs: null,
          title: 'Codex reset',
          description: null,
        }],
      },
    })).toMatchObject({
      recoveryCredits: {
        availableCount: 1,
        totalCount: 1,
        credits: [{
          providerCreditId: 'reset-credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
        }],
      },
    });
  });

  it('resolves resumePromptMode by explicit, existing intent, group, account, then default precedence', () => {
    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: 'standard',
      existingIntent: { resumePromptMode: 'off' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: null,
      existingIntent: { resumePromptMode: 'off' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
      groupPolicy: { resumePromptMode: 'standard' },
    })).toBe('off');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      existingIntent: {},
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      groupPolicy: { resumePromptMode: 'standard' },
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      accountSettings: {},
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('off');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      groupPolicy: {},
    })).toBe('standard');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({})).toBe('standard');
  });

  it('resolves custom resume prompt mode like any tier value', () => {
    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      explicit: 'custom',
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).toBe('custom');

    expect(resolveSessionUsageLimitRecoveryResumePromptModeV1({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } },
      groupPolicy: { resumePromptMode: 'off' },
    })).toBe('off');
  });
});
