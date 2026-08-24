import { describe, expect, it } from 'vitest';

import { classifyCodexConnectedServiceAuthFailure } from './classifyCodexConnectedServiceAuthFailure';

describe('classifyCodexConnectedServiceAuthFailure', () => {
  it('classifies ChatGPT account model incompatibility as plan-invalid recovery evidence', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          type: 'invalid_request_error',
          message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      },
      serviceId: 'openai-codex',
      profileId: 'free-account',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'permission_denied',
      limitCategory: 'plan_invalid',
      source: 'structured_provider_error',
    });
  });

  it('recognizes structured usage-limit failures and extracts provider metadata', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
          resets_at: '2026-05-17T15:30:00.000Z',
          plan_type: 'plus',
          rate_limits: { primary: { used_percent: 100 } },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
      resetsAtMs: Date.parse('2026-05-17T15:30:00.000Z'),
      planType: 'plus',
      rateLimits: { primary: { used_percent: 100 } },
      source: 'structured_provider_error',
    });
  });

  it('attaches exact source account identity to usage-limit failures when the runtime supplies it', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
      sourceAccountIdentity: {
        providerAccountId: 'acct-source',
        accountLabel: 'source@example.test',
        groupGeneration: 42,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        credentialFingerprint: 'sha256:abcdef12',
      },
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      sourceProviderAccountId: 'acct-source',
      sourceAccountLabel: 'source@example.test',
      groupGeneration: 42,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    });
  });

  it('classifies structured usage-limit recovery as quota recovery, not provider state sharing', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result?.recoveryAction).toEqual({ kind: 'quota_recovery_required' });
    expect(result?.recoveryAction?.kind).not.toBe('provider_state_sharing_required');
  });

  it('classifies stable-message usage-limit recovery as quota recovery, not provider state sharing', () => {
    const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:27 PM.";
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error(message),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    });

    expect(result?.kind).toBe('usage_limit');
    expect(result?.recoveryAction).toEqual({ kind: 'quota_recovery_required' });
  });

  it('classifies a stable usage-limit message nested in an app-server terminal error', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        turn: {
          error: {
            message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
          },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      source: 'stable_provider_message',
      recoveryAction: { kind: 'quota_recovery_required' },
    });
  });

  it('preserves structured retry-after usage-limit timing when no reset time is present', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
          retry_after_ms: 120_000,
          plan_type: 'plus',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      retryAfterMs: 120_000,
      source: 'structured_provider_error',
    });
  });

  it('does not use ambiguous stable retry wording as structured usage-limit reset metadata', () => {

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
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      retryAfterMs: null,
      source: 'structured_provider_error',
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

  it('does not extract daemon-local reset times from stable Codex usage-limit retry wording', () => {

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:27 PM."),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    })).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      source: 'stable_provider_message',
    });
  });

  it('does not extract daemon-local reset dates from stable Codex usage-limit retry wording', () => {

    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 27th, 2026 3:55 PM."),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
    })).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: null,
      source: 'stable_provider_message',
    });
  });

  it('does not treat Codex temporary server throttles as connected-service usage exhaustion', () => {
    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toBeNull();
  });

  it('classifies the observed model-capacity failure for provider-scoped retry recovery', () => {
    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        turn: {
          error: {
            message: 'Selected model is at capacity. Please try a different model.',
            codexErrorInfo: 'other',
            additionalDetails: null,
          },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
      source: 'structured_provider_error',
    });
  });

  it('classifies the observed high-demand terminal failure for provider-scoped retry recovery', () => {
    expect(classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: new Error("We're currently experiencing high demand. Please try again shortly."),
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'pool',
    })).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
      source: 'structured_provider_error',
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

  it('recognizes compact token invalidation as an auth-expired failure', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again.',
          code: 'token_invalidated',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
      source: 'structured_provider_error',
    });
  });

  it('recognizes revoked compact oauth tokens as an auth-expired failure', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request',
          code: 'token_revoked',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
      source: 'structured_provider_error',
    });
  });

  it('recognizes reused refresh tokens as refresh failures', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        turn: {
          error: {
            message: 'Failed to refresh token: 401 Unauthorized: Your refresh token has already been used to generate a new access token.',
            code: 'refresh_token_reused',
          },
        },
      },
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'refresh_failed',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: 'happier',
      source: 'structured_provider_error',
    });
  });

  it('recognizes alternate reused refresh token wording as refresh failures', () => {
    const result = classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error: {
        error: {
          message: 'Failed to refresh token: 401 Unauthorized: Your refresh token was already used to generate a new access token.',
        },
      },
      serviceId: 'openai-codex',
      profileId: 'bot',
      groupId: 'happier',
    });

    expect(result).toMatchObject({
      kind: 'refresh_failed',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'bot',
      groupId: 'happier',
      source: 'structured_provider_error',
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
