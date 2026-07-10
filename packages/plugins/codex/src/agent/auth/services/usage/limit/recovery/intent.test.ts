import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import { describe, expect, it } from 'vitest';

import {
  buildCodexUsageLimitRecoveryProbeResult,
  readCodexUsageLimitRecoveryIntent,
  resolveCodexUsageLimitRecoveryIntent,
} from './intent.js';

function createUsageLimitIssue(
  usageLimit: SessionRuntimeIssueV1['usageLimit'],
): SessionRuntimeIssueV1 {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    agentTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit,
  };
}

function createWaitingIntent(overrides: Partial<SessionUsageLimitRecoveryV1> = {}): SessionUsageLimitRecoveryV1 {
  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
    armedAtMs: 1_700_000_000_000,
    resetAtMs: null,
    nextCheckAtMs: null,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    ...overrides,
  };
}

describe('Codex usage-limit recovery intent', () => {
  it('reads only valid non-cancelled persisted recovery intent from metadata', () => {
    const waiting = createWaitingIntent();

    expect(readCodexUsageLimitRecoveryIntent({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: waiting,
    })).toEqual(waiting);
    expect(readCodexUsageLimitRecoveryIntent({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...waiting, status: 'cancelled' },
    })).toBeNull();
    expect(readCodexUsageLimitRecoveryIntent({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...waiting, attemptCount: -1 },
    })).toBeNull();
  });

  it('builds Codex recovery intent from latest failed usage-limit issue with selected group auth', () => {
    const intent = resolveCodexUsageLimitRecoveryIntent({
      metadata: {},
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({
        v: 1,
        resetAtMs: null,
        retryAfterMs: 120_000,
        quotaScope: 'account',
        recoverability: 'wait',
        connectedService: {
          serviceId: 'openai-codex',
          groupId: 'group-1',
          profileId: 'profile-1',
        },
      }),
      resumePromptMode: 'off',
      deriveTiming: (issue) => ({
        resetAtMs: issue.usageLimit?.resetAtMs ?? null,
        nextCheckAtMs:
          issue.usageLimit?.retryAfterMs === null || issue.usageLimit?.retryAfterMs === undefined
            ? null
            : issue.occurredAt + issue.usageLimit.retryAfterMs,
      }),
    });

    expect(intent).toMatchObject({
      status: 'waiting',
      resumePromptMode: 'off',
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
      armedAtMs: 1_700_000_000_000,
      resetAtMs: null,
      nextCheckAtMs: 1_700_000_120_000,
      attemptCount: 0,
      maxAttempts: 3,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'group-1',
        profileId: 'profile-1',
      },
    });
  });

  it('preserves selected group auth when the latest usage-limit issue omits the selected profile', () => {
    const intent = resolveCodexUsageLimitRecoveryIntent({
      metadata: {},
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({
        v: 1,
        resetAtMs: null,
        retryAfterMs: 120_000,
        quotaScope: 'account',
        recoverability: 'wait',
        connectedService: {
          serviceId: 'openai-codex',
          groupId: 'group-1',
          profileId: null,
        },
      }),
      deriveTiming: () => ({
        resetAtMs: null,
        nextCheckAtMs: null,
      }),
    });

    expect(intent).toMatchObject({
      status: 'waiting',
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'group-1',
        profileId: null,
      },
    });
  });

  it('preserves explicit custom resume prompt mode on new and persisted intents', () => {
    expect(resolveCodexUsageLimitRecoveryIntent({
      metadata: {},
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
      }),
      resumePromptMode: 'custom',
      deriveTiming: () => ({
        resetAtMs: null,
        nextCheckAtMs: null,
      }),
    })).toMatchObject({
      status: 'waiting',
      resumePromptMode: 'custom',
    });

    expect(resolveCodexUsageLimitRecoveryIntent({
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent({ resumePromptMode: 'custom' }),
      },
      latestTurnStatus: 'failed',
      resumePromptMode: undefined,
      deriveTiming: () => ({
        resetAtMs: null,
        nextCheckAtMs: null,
      }),
    })).toMatchObject({
      status: 'waiting',
      resumePromptMode: 'custom',
    });

    expect(resolveCodexUsageLimitRecoveryIntent({
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent({ resumePromptMode: 'custom' }),
      },
      latestTurnStatus: 'failed',
      resumePromptMode: 'off',
      deriveTiming: () => ({
        resetAtMs: null,
        nextCheckAtMs: null,
      }),
    })).toMatchObject({
      status: 'waiting',
      resumePromptMode: 'off',
    });
  });

  it('does not arm intent from active turns or non-usage runtime issues', () => {
    const issue = createUsageLimitIssue({
      v: 1,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
    });

    expect(resolveCodexUsageLimitRecoveryIntent({
      metadata: {},
      latestTurnStatus: 'in_progress',
      lastRuntimeIssue: issue,
      deriveTiming: () => ({ resetAtMs: null, nextCheckAtMs: null }),
    })).toBeNull();
    expect(resolveCodexUsageLimitRecoveryIntent({
      metadata: {},
      latestTurnStatus: 'failed',
      lastRuntimeIssue: { ...issue, source: 'auth_error', usageLimit: undefined },
      deriveTiming: () => ({ resetAtMs: null, nextCheckAtMs: null }),
    })).toBeNull();
  });

  it('maps Codex rate-limit probe snapshots into ready or waiting recovery state', () => {
    const ready = buildCodexUsageLimitRecoveryProbeResult({
      intent: createWaitingIntent(),
      rawSnapshot: { primary: { usedPercent: 42 } },
    });
    const waiting = buildCodexUsageLimitRecoveryProbeResult({
      intent: createWaitingIntent({ attemptCount: 1 }),
      rawSnapshot: {
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: 1_779_098_400 },
        },
      },
    });

    expect(ready).toMatchObject({
      status: 'ready',
      intent: {
        status: 'cancelled',
        attemptCount: 1,
        lastProbeError: null,
      },
    });
    expect(waiting).toMatchObject({
      status: 'waiting',
      intent: {
        status: 'waiting',
        attemptCount: 2,
        resetAtMs: Date.parse('2026-05-18T10:00:00.000Z'),
        nextCheckAtMs: Date.parse('2026-05-18T10:00:00.000Z'),
        lastProbeError: null,
      },
    });
  });
});
