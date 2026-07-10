import { describe, expect, it } from 'vitest';

import {
  SessionRuntimeIssueV1Schema,
  SessionRuntimeTemporaryThrottleDetailsV1Schema,
  SessionRuntimeUsageLimitDetailsV1Schema,
  sanitizeSessionRuntimeIssueV1,
} from './runtimeIssueV1.js';

describe('SessionRuntimeUsageLimitDetailsV1Schema', () => {
  const baseDetails = {
    v: 1,
    resetAtMs: 1_000,
    retryAfterMs: 500,
    quotaScope: 'account',
    recoverability: 'wait',
  } as const;

  it('requires a URL for open_url actions', () => {
    expect(() => SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'open_url',
        labelKey: 'provider_usage_settings',
      },
    })).toThrow();

    expect(SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'open_url',
        labelKey: 'provider_usage_settings',
        url: 'https://example.com/usage',
      },
    }).action).toEqual({
      kind: 'open_url',
      labelKey: 'provider_usage_settings',
      url: 'https://example.com/usage',
    });
  });

  it('keeps settings and none actions minimal', () => {
    expect(SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'settings',
      },
    }).action).toEqual({
      kind: 'settings',
    });
    expect(SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'none',
      },
    }).action).toEqual({
      kind: 'none',
    });

    expect(() => SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'settings',
        url: 'https://example.com/usage',
      },
    })).toThrow();
    expect(() => SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      action: {
        kind: 'none',
        labelKey: 'provider_usage_settings',
      },
    })).toThrow();
  });

  it('parses normalized limit category and effective meter recovery fields', () => {
    const parsed = SessionRuntimeUsageLimitDetailsV1Schema.parse({
      ...baseDetails,
      limitCategory: 'usage_limit',
      quotaSnapshotRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-main',
        fetchedAtMs: 2_000,
      },
      effectiveMeterId: 'weekly',
      effectiveRemainingPct: 7,
      allWindows: [
        {
          meterId: 'daily',
          scope: 'daily',
          remainingPct: 42,
          resetAtMs: 3_000,
          status: 'ok',
        },
        {
          meterId: 'weekly',
          scope: 'weekly',
          remainingPct: 7,
          resetAtMs: 4_000,
          status: 'ok',
        },
      ],
      recoveryDecision: 'switching',
    });

    expect(parsed.limitCategory).toBe('usage_limit');
    expect(parsed.effectiveMeterId).toBe('weekly');
    expect(parsed.effectiveRemainingPct).toBe(7);
    expect(parsed.allWindows).toHaveLength(2);
    expect(parsed.recoveryDecision).toBe('switching');
  });

  it('parses temporary provider throttle details outside usage-limit details', () => {
    const throttle = SessionRuntimeTemporaryThrottleDetailsV1Schema.parse({
      v: 1,
      retryAfterMs: 30_000,
      recoverability: 'retry',
    });

    expect(throttle).toEqual({
      v: 1,
      retryAfterMs: 30_000,
      recoverability: 'retry',
    });
    expect(SessionRuntimeIssueV1Schema.parse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_temporary_throttle',
      source: 'agent_status_error',
      occurredAt: 1_000,
      provider: 'codex',
      sanitizedPreview: 'Provider is temporarily limiting requests',
      temporaryThrottle: throttle,
    })).toMatchObject({
      source: 'agent_status_error',
      temporaryThrottle: throttle,
    });
  });
});

describe('SessionRuntimeIssueV1Schema', () => {
  it('accepts dependency failure runtime issues', () => {
    const parsed = SessionRuntimeIssueV1Schema.safeParse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'dependency_failure',
      source: 'dependency_failure',
      occurredAt: 1,
      sanitizedPreview: 'Provider dependency failed',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts temporary throttle details separately from usage limits', () => {
    const parsed = SessionRuntimeIssueV1Schema.safeParse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_temporary_throttle',
      source: 'agent_status_error',
      occurredAt: 1,
      sanitizedPreview: 'Provider is temporarily limiting requests',
      temporaryThrottle: {
        v: 1,
        retryAfterMs: 12_000,
        recoverability: 'retry',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Expected runtime issue to parse');
    expect(parsed.data.temporaryThrottle).toEqual({
      v: 1,
      retryAfterMs: 12_000,
      recoverability: 'retry',
    });
  });

  it('accepts persisted temporary throttle recoverability values written by dev and remote-dev', () => {
    for (const recoverability of ['manual', 'wait'] as const) {
      const parsed = SessionRuntimeIssueV1Schema.safeParse({
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_temporary_throttle',
        source: 'agent_status_error',
        occurredAt: 1,
        temporaryThrottle: {
          v: 1,
          retryAfterMs: null,
          recoverability,
        },
      });

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error(`Expected ${recoverability} throttle issue to parse`);
      expect(parsed.data.temporaryThrottle?.recoverability).toBe(recoverability);
    }
  });

  it('accepts provider process exits after connected-service switches', () => {
    const parsed = SessionRuntimeIssueV1Schema.safeParse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'agent_process_exit_after_switch',
      source: 'agent_process_exit_after_switch',
      occurredAt: 1_000,
      provider: 'pi',
      sanitizedPreview: 'Provider process exited after connected-service switch',
      agentProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file missing',
        vendorResumeId: 'resume_123',
        materializationRoot: '/tmp/happier/pi-home',
        effectiveStateMode: 'isolated',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Expected provider process-exit-after-switch issue to parse');
    expect(parsed.data).toMatchObject({
      source: 'agent_process_exit_after_switch',
      agentProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file missing',
        vendorResumeId: 'resume_123',
        materializationRoot: '/tmp/happier/pi-home',
        effectiveStateMode: 'isolated',
      },
    });
  });

  it('normalizes deployed provider-vocabulary runtime issues', () => {
    const parsed = SessionRuntimeIssueV1Schema.parse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_process_exit_after_switch',
      source: 'provider_process_exit_after_switch',
      occurredAt: 1_000,
      provider: 'pi',
      providerTurnId: 'turn-1',
      providerProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file missing',
        vendorResumeId: 'resume_123',
        materializationRoot: '/tmp/happier/pi-home',
        effectiveStateMode: 'isolated',
      },
    });

    expect(parsed).toMatchObject({
      code: 'agent_process_exit_after_switch',
      source: 'agent_process_exit_after_switch',
      agentId: 'pi',
      agentTurnId: 'turn-1',
      agentProcessExitAfterSwitch: {
        exitCode: 1,
        vendorResumeId: 'resume_123',
      },
    });
    expect(parsed).not.toHaveProperty('provider');
    expect(parsed).not.toHaveProperty('providerTurnId');
    expect(parsed).not.toHaveProperty('providerProcessExitAfterSwitch');
  });
});

describe('sanitizeSessionRuntimeIssueV1', () => {
  it('drops unsafe usage-limit provider strings and action URLs', () => {
    const sanitized = sanitizeSessionRuntimeIssueV1({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 1_000,
      provider: 'codex',
      sanitizedPreview: 'Usage limit reached',
      usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'Bearer secret-provider-limit-token',
        planType: 'enterprise secret plan',
        action: {
          kind: 'open_url',
          url: 'https://provider.example/usage?access_token=secret#fragment',
        },
      },
    });

    expect(sanitized?.usageLimit).toMatchObject({
      v: 1,
      resetAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
    });
    expect(sanitized?.usageLimit).not.toHaveProperty('providerLimitId');
    expect(sanitized?.usageLimit?.planType).toBeNull();
    expect(sanitized?.usageLimit).not.toHaveProperty('action');
  });

  it('preserves safe usage-limit provider strings and action URLs', () => {
    const sanitized = sanitizeSessionRuntimeIssueV1({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 1_000,
      provider: 'codex',
      sanitizedPreview: 'Usage limit reached',
      usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'weekly',
        planType: 'team',
        action: {
          kind: 'open_url',
          url: 'https://provider.example/usage',
        },
      },
    });

    expect(sanitized?.usageLimit).toMatchObject({
      providerLimitId: 'weekly',
      planType: 'team',
      action: {
        kind: 'open_url',
        url: 'https://provider.example/usage',
      },
    });
  });
});
