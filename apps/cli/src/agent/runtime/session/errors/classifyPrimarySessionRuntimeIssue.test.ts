import { describe, expect, it } from 'vitest';

import { classifyPrimarySessionRuntimeIssue } from './classifyPrimarySessionRuntimeIssue';

describe('classifyPrimarySessionRuntimeIssue', () => {
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

  it('sanitizes runtime auth classification metadata before surfacing session-visible usage-limit details', () => {
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
      accessToken?: string;
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'Bearer secret-provider-limit-token',
      planType: 'enterprise secret plan',
      rateLimits: {
        primary: { usedPercent: 100 },
        refreshToken: 'secret-refresh-token',
      },
      action: {
        kind: 'open_url',
        url: 'https://provider.example/recover?access_token=secret-access-token#secret-fragment',
      },
      source: 'structured_provider_error',
    };
    error.accessToken = 'secret-access-token';

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        limitCategory: 'usage_limit',
        planType: null,
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
        },
      },
    });
    expect(issue.usageLimit?.providerLimitId).toBeUndefined();
    expect(issue.usageLimit?.action).toBeUndefined();

    const issueText = JSON.stringify(issue);
    expect(issueText).not.toContain('secret-provider-limit-token');
    expect(issueText).not.toContain('enterprise secret plan');
    expect(issueText).not.toContain('secret-access-token');
    expect(issueText).not.toContain('secret-refresh-token');
  });

  it('surfaces native provider usage limits without connected-service recovery metadata', () => {
    const error = new Error('native provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
        connectedServiceRecovery: 'unavailable';
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      planType: 'pro',
      rateLimits: null,
      source: 'structured_provider_error',
      connectedServiceRecovery: 'unavailable',
    };

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'wait',
        limitCategory: 'usage_limit',
        planType: 'pro',
      },
    });
    expect(issue.usageLimit?.connectedService).toBeUndefined();
  });

  it('treats missing connected-service recovery context as native provider metadata', () => {
    const error = new Error('native provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      planType: 'pro',
      rateLimits: null,
      source: 'structured_provider_error',
    };

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue.usageLimit).toMatchObject({
      recoverability: 'wait',
    });
    expect(issue.usageLimit?.connectedService).toBeUndefined();
  });

  it('extracts reset times from stable usage-limit retry wording when structured details are absent', () => {
    const occurredAt = new Date(2026, 4, 18, 13, 2, 41, 0).getTime();
    const resetAt = new Date(2026, 4, 18, 13, 48, 0, 0).getTime();

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:48 PM."),
      occurredAt,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: resetAt,
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
      source: 'agent_status_error',
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
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: {
        message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
        retryAfterMs: 12_000,
      },
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'agent_status_error',
      code: 'provider_temporary_throttle',
      sanitizedPreview: 'Provider is temporarily limiting requests',
      temporaryThrottle: {
        v: 1,
        retryAfterMs: 12_000,
        recoverability: 'retry',
      },
    });
    expect(issue.usageLimit).toBeUndefined();
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

  it('maps connected-service runtime auth dependency failures into first-class runtime issues', () => {
    const error = new Error('provider dependency failed') as Error & {
      runtimeAuthClassification: {
        kind: 'dependency_failure';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'dependency_failure',
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: 'pi-main',
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
      source: 'dependency_failure',
      code: 'dependency_failure',
      sanitizedPreview: 'Provider dependency failed',
    });
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    }).usageLimit).toBeUndefined();
  });

  it('keeps auth, plan, and validation runtime auth classifications structured', () => {
    for (const [kind, expectedSource, expectedCategory] of [
      ['auth_expired', 'auth_error', 'auth_invalid'],
      ['plan', 'agent_status_error', 'plan_invalid'],
      ['validation', 'agent_status_error', 'validation_failed'],
    ] as const) {
      const error = new Error(kind) as Error & {
        runtimeAuthClassification: {
          kind: typeof kind;
          serviceId: string;
          profileId: string | null;
          groupId: string | null;
          resetsAtMs?: number | null;
          limitCategory?: typeof expectedCategory;
          source: string;
        };
      };
      error.runtimeAuthClassification = {
        kind,
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: 9_000,
        limitCategory: expectedCategory,
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

  it('surfaces provider process exits after connected-service switches with structured details', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'process_exit',
      occurredAt: 2_000,
      error: {
        agentProcessExitAfterSwitch: {
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
      source: 'agent_process_exit_after_switch',
      code: 'agent_process_exit_after_switch',
      sanitizedPreview: 'Provider process exited after connected-service switch',
      agentProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file 019e... not found',
        vendorResumeId: '019e6942',
        materializationRoot: '/tmp/happier/connected-services/pi',
        effectiveStateMode: 'isolated',
      },
    });
  });

  it('does not attach temporary throttle details to provider process exits after switches', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'process_exit',
      occurredAt: 2_000,
      error: {
        message: 'API Error: Server is temporarily limiting requests (not your usage limit)',
        agentProcessExitAfterSwitch: {
          exitCode: 1,
          signal: null,
          lastStderrLine: 'session file missing',
          vendorResumeId: '019e6942',
          materializationRoot: '/tmp/happier/connected-services/pi',
          effectiveStateMode: 'isolated',
        },
      },
    });

    expect(issue).toMatchObject({
      source: 'agent_process_exit_after_switch',
      code: 'agent_process_exit_after_switch',
    });
    expect(issue.temporaryThrottle).toBeUndefined();
  });
});
