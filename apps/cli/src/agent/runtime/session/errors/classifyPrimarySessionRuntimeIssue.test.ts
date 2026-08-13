import { describe, expect, it } from 'vitest';

import { classifyPrimarySessionRuntimeIssue } from './classifyPrimarySessionRuntimeIssue';

describe('classifyPrimarySessionRuntimeIssue', () => {
  it('preserves a Pi-owned provider failure code and sanitized preview', () => {
    const error = Object.assign(new Error('Pi provider reported provider failure after prompt acceptance'), {
      piProviderFailure: {
        code: 'provider_auth_failed',
        sanitizedPreview: 'Pi provider reported provider failure after prompt acceptance: code=provider_auth_failed, message=Credential [REDACTED] was rejected',
      },
    });

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'session_error',
      error,
      occurredAt: 123,
    })).toMatchObject({
      code: 'provider_auth_failed',
      source: 'provider_session_error',
      sanitizedPreview: 'Pi provider reported provider failure after prompt acceptance: code=provider_auth_failed, message=Credential [REDACTED] was rejected',
    });
  });

  it('maps connected-service runtime auth classifications into usage-limit details', () => {
    const error = new Error('provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        providerLimitId?: string | null;
        planType: string | null;
        rateLimits: unknown | null;
        action?: { kind: 'open_url'; url: string } | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly_tokens',
      planType: 'pro',
      rateLimits: {
        primary: { usedPercent: 100 },
        action: { kind: 'open_url', url: 'https://opencode.ai/billing' },
      },
      source: 'structured_provider_error',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        limitCategory: 'usage_limit',
        providerLimitId: 'weekly_tokens',
        planType: 'pro',
        action: {
          kind: 'open_url',
          url: 'https://opencode.ai/billing',
        },
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'codex-main',
        },
      },
    });
  });

  it('does not turn ambiguous wall-clock usage-limit retry wording into a daemon-local reset time', () => {
    const occurredAt = new Date(2026, 4, 18, 13, 2, 41, 0).getTime();

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:48 PM."),
      occurredAt,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'unknown',
        recoverability: 'wait',
      },
    });
  });

  it('uses shared provider-limit wording for quota exhaustion text', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'opencode',
      cause: 'status_error',
      error: new Error('Provider request failed because account credits exhausted.'),
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        quotaScope: 'unknown',
        recoverability: 'wait',
      },
    });
  });

  it('keeps capacity runtime auth classifications distinct from usage limits', () => {
    const error = new Error('provider overloaded') as Error & {
      runtimeAuthClassification: {
        kind: 'capacity';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        retryAfterMs?: number | null;
        limitCategory?: 'capacity';
        providerLimitId?: string | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'capacity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
      retryAfterMs: 45_000,
      limitCategory: 'capacity',
      providerLimitId: 'server_overloaded',
      source: 'structured_provider_error',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'provider_status_error',
      usageLimit: {
        v: 1,
        retryAfterMs: 45_000,
        limitCategory: 'capacity',
        providerLimitId: 'server_overloaded',
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
        },
      },
    });
  });

  it('does not classify provider temporary throttles as usage-limit exhaustion', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: new Error('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'provider_status_error',
      code: 'provider_temporary_throttle',
      sanitizedPreview: 'Provider is temporarily limiting requests',
      temporaryThrottle: {
        v: 1,
        retryAfterMs: null,
        recoverability: 'retry',
      },
    });
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: new Error('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
      occurredAt: 1_000,
    }).usageLimit).toBeUndefined();
  });

  it('reads retry-after-ms temporary throttle headers as milliseconds', () => {
    const error = Object.assign(
      new Error('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
      {
        headers: {
          'retry-after-ms': '2500',
        },
      },
    );

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      code: 'provider_temporary_throttle',
      temporaryThrottle: {
        retryAfterMs: 2_500,
      },
    });
  });

  it('keeps auth, plan, and validation runtime auth classifications structured', () => {
    for (const [kind, expectedSource, inputCategory, expectedCategory] of [
      ['auth_expired', 'auth_error', 'auth_invalid', 'auth_invalid'],
      ['plan', 'provider_status_error', 'plan_invalid', 'plan_invalid'],
      ['validation', 'provider_status_error', 'validation_failed', 'validation_failed'],
    ] as const) {
      const error = new Error(kind) as Error & {
        runtimeAuthClassification: {
          kind: typeof kind;
          serviceId: string;
          profileId: string | null;
          groupId: string | null;
          resetsAtMs?: number | null;
          limitCategory?: typeof inputCategory;
          source: string;
        };
      };
      error.runtimeAuthClassification = {
        kind,
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: 9_000,
        limitCategory: inputCategory,
        source: 'structured_provider_error',
      };

      expect(classifyPrimarySessionRuntimeIssue({
        provider: 'codex',
        cause: 'status_error',
        error,
        occurredAt: 1_000,
      })).toMatchObject({
        source: expectedSource,
        usageLimit: {
          v: 1,
          resetAtMs: 9_000,
          limitCategory: expectedCategory,
          connectedService: {
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'codex-main',
          },
        },
      });
    }
  });

  it('maps connected-service dependency failures to dependency runtime issues', () => {
    const error = new Error('context compaction dependency failed') as Error & {
      runtimeAuthClassification: {
        kind: 'dependency_failure';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: null;
        planType: null;
        rateLimits: null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'dependency_failure',
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude-main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      code: 'dependency_failure',
      source: 'dependency_failure',
      sanitizedPreview: 'Provider dependency failed',
    });
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    }).usageLimit).toBeUndefined();
  });

  it('surfaces provider process exits after switch with structured connected-service context', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'process_exit',
      occurredAt: 2_000,
      error: {
        providerProcessExitAfterSwitch: {
          exitCode: 1,
          signal: null,
          lastStderrLine: 'session file 019e... not found',
          vendorResumeId: '019e6942',
          materializationRoot: '/tmp/happier/connected-services/pi',
          effectiveStateMode: 'isolated',
        },
      },
    });

    expect(issue).toMatchObject({
      source: 'provider_process_exit_after_switch',
      code: 'provider_process_exit_after_switch',
      sanitizedPreview: 'Provider process exited after connected-service switch',
      providerProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file 019e... not found',
        vendorResumeId: '019e6942',
        materializationRoot: '/tmp/happier/connected-services/pi',
        effectiveStateMode: 'isolated',
      },
    });
  });
});
