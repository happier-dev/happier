import { describe, expect, it } from 'vitest';

import { classifyCodexConnectedServiceAuthFailure } from './failure.js';

describe('classifyCodexConnectedServiceAuthFailure', () => {
  it('recognizes structured usage-limit failures and extracts provider metadata', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
          resets_at: '2026-05-17T15:30:00.000Z',
          retry_after_ms: 90_000,
          plan_type: 'plus',
          rate_limits: { primary: { used_percent: 100 } },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
      sourceAccountIdentity: {
        providerAccountId: 'acct_source',
        accountLabel: 'source@example.test',
        groupGeneration: 42,
      },
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
      resetsAtMs: Date.parse('2026-05-17T15:30:00.000Z'),
      retryAfterMs: 90_000,
      planType: 'plus',
      rateLimits: { primary: { used_percent: 100 } },
      source: 'structured_provider_error',
      recoveryAction: { kind: 'quota_recovery_required' },
      sourceProviderAccountId: 'acct_source',
      sourceAccountLabel: 'source@example.test',
      groupGeneration: 42,
    });
  });

  it('recognizes structured Codex usage-limit code variants', () => {
    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          codexErrorInfo: 'usageLimitExceeded',
          message: 'request failed',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toMatchObject({
      kind: 'usage_limit',
      source: 'structured_provider_error',
    });

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          code: 'usage_limit_reached',
          message: 'request failed',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toMatchObject({
      kind: 'usage_limit',
      source: 'structured_provider_error',
    });

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          code: 'UsageLimitReached',
          message: 'request failed',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toMatchObject({
      kind: 'usage_limit',
      source: 'structured_provider_error',
    });
  });

  it('does not treat ambiguous full-date retry wording as authoritative reset metadata', () => {
    const now = new Date(2026, 4, 27, 7, 20, 0, 0).getTime();

    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 30th, 2026 10:23 PM.",
          codexErrorInfo: 'UsageLimitExceeded',
          plan_type: 'plus',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: 'happier',
      nowMs: now,
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      retryAfterMs: null,
      source: 'structured_provider_error',
    });
  });

  it('recognizes the observed Codex usage-limit message only on provider error paths', () => {
    const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:27 PM.";

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error(message),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    })).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      source: 'stable_provider_message',
    });

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: false,
      error: new Error(message),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    })).toBeNull();
  });

  it('routes temporary provider throttles as retry controls instead of usage-limit fallback', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
          retry_after_ms: 2_500,
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result).toMatchObject({
      kind: 'temporary_throttle',
      limitCategory: 'rate_limit',
      retryAfterMs: 2_500,
      source: 'structured_provider_error',
    });
  });

  it('does not treat ambiguous local-time retry wording as authoritative reset metadata', () => {
    const now = new Date(2026, 4, 17, 16, 0, 0, 0).getTime();

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:27 PM."),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      nowMs: now,
    })).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      source: 'stable_provider_message',
    });
  });

  it('does not treat ambiguous full-date retry wording as authoritative reset metadata', () => {
    const now = new Date(2026, 4, 17, 16, 0, 0, 0).getTime();

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 27th, 2026 3:55 PM."),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      nowMs: now,
    })).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      source: 'stable_provider_message',
    });
  });

  it('recognizes account-changed auth failures', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        turn: {
          error: {
            message: 'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
            codex_error_info: 'Unauthorized',
          },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result).toMatchObject({
      kind: 'account_changed',
      source: 'structured_provider_error',
    });
  });

  it('recognizes revoked compact oauth tokens as auth-expired failures', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        turn: {
          error: {
            message: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request',
            code: 'token_revoked',
          },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
    });
  });

  it('recognizes revoked refresh token wording observed from Codex app-server refresh failures', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'batiplus',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'refresh_failed',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'batiplus',
      groupId: 'happier',
      source: 'structured_provider_error',
    });
  });
});
