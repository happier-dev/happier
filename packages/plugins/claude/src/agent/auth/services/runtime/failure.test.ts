import { describe, expect, it, vi } from 'vitest';

type ClaudeRuntimeAuthEnvIsolator = (
  env: Record<string, string | undefined>,
) => Record<string, string | undefined>;

type ClaudeRuntimeAuthEnvDiagnosticResolver = (
  env: Record<string, string | undefined>,
) => Readonly<{
  presentAuthEnvKeys: readonly string[];
  hasAnthropicApiKey: boolean;
  hasAnthropicAuthToken: boolean;
  hasAnthropicOauthToken: boolean;
  hasClaudeCodeOauthToken: boolean;
  hasClaudeCodeSetupToken: boolean;
  hasClaudeCodeOauthRefreshToken: boolean;
  hasClaudeCodeOauthScopes: boolean;
  hasClaudeConfigDir: boolean;
  hasHappierConnectedServiceSelections: boolean;
}>;

function readRuntimeAuthEnvIsolator(
  moduleRecord: Record<string, unknown>,
): ClaudeRuntimeAuthEnvIsolator {
  const fn = moduleRecord.isolateClaudeRuntimeAuthEnv;
  expect(fn).toEqual(expect.any(Function));
  if (typeof fn !== 'function') {
    throw new Error('Expected isolateClaudeRuntimeAuthEnv to be exported');
  }
  return (env) => fn(env) as Record<string, string | undefined>;
}

function readRuntimeAuthEnvDiagnosticResolver(
  moduleRecord: Record<string, unknown>,
): ClaudeRuntimeAuthEnvDiagnosticResolver {
  const fn = moduleRecord.resolveClaudeRuntimeAuthEnvDiagnostic;
  expect(fn).toEqual(expect.any(Function));
  if (typeof fn !== 'function') {
    throw new Error('Expected resolveClaudeRuntimeAuthEnvDiagnostic to be exported');
  }
  return (env) => fn(env) as ReturnType<ClaudeRuntimeAuthEnvDiagnosticResolver>;
}

describe('Claude runtime auth service classification', () => {
  it('classifies Claude SDK rate-limit events from the plugin auth service path', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');

    const result = classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      error: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1_768_100_000_000,
          rateLimitType: 'five_hour',
          utilization: 100,
          overageStatus: 'rejected',
          overageResetsAt: 1_768_200_000_000,
          overageDisabledReason: 'out_of_credits',
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      resetsAtMs: 1_768_100_000_000,
      rateLimits: expect.objectContaining({
        providerLimitId: 'five_hour',
        utilization: 100,
        overage: {
          status: 'rejected',
          resetAtMs: 1_768_200_000_000,
          disabledReason: 'out_of_credits',
        },
      }),
      source: 'structured_provider_error',
    });
  });

  it('classifies Retry-After HTTP dates with reset and relative retry timing', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));
    try {
      const resetAtMs = Date.parse('2026-05-17T12:00:30.000Z');

      const result = classifyClaudeConnectedServiceRuntimeAuthFailure({
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'main',
        error: {
          response: {
            headers: {
              'Retry-After': 'Sun, 17 May 2026 12:00:30 GMT',
            },
          },
        },
      });

      expect(result).toMatchObject({
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'main',
        resetsAtMs: resetAtMs,
        retryAfterMs: 30_000,
        rateLimits: expect.objectContaining({
          resetAtMs,
          retryAfterMs: 30_000,
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies Claude overloaded provider errors as capacity failures', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');

    const result = classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      error: {
        type: 'assistant_response',
        api_error_status: 529,
        message: 'Claude API overloaded_error: server is overloaded',
      },
    });

    expect(result).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      providerLimitId: 'server_overloaded',
      quotaScope: 'provider',
      source: 'structured_provider_error',
    });
  });

  it('classifies nested Claude auth evidence as auth-expired', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');

    expect(classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      error: {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [
          {
            type: 'authentication_error',
            message: 'OAuth token has expired',
          },
        ],
      },
    })).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      source: 'structured_provider_error',
    });
  });

  it('isolates connected Claude subscription runtime env to the materialized config root', async () => {
    const isolateClaudeRuntimeAuthEnv = readRuntimeAuthEnvIsolator(await import('./index.js'));
    const env = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
      ]),
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CLAUDE_CONFIG_DIR']),
      CLAUDE_CONFIG_DIR: '/tmp/happier-claude-materialized',
      ANTHROPIC_API_KEY: 'ambient-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh-token',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
      CUSTOM_RUNTIME_ENV: 'keep',
    };

    const result = isolateClaudeRuntimeAuthEnv(env);

    expect(result).toBe(env);
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/happier-claude-materialized',
      CUSTOM_RUNTIME_ENV: 'keep',
    });
  });

  it('preserves only Claude subscription OAuth when no materialized key list is available', async () => {
    const isolateClaudeRuntimeAuthEnv = readRuntimeAuthEnvIsolator(await import('./index.js'));
    const env = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
      ]),
      CLAUDE_CONFIG_DIR: '/tmp/happier-claude-materialized',
      ANTHROPIC_API_KEY: 'ambient-api-key',
      ANTHROPIC_AUTH_TOKEN: 'ambient-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'connected-oauth-token',
      CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    };

    const result = isolateClaudeRuntimeAuthEnv(env);

    expect(result).toBe(env);
    expect(result).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/happier-claude-materialized',
      CLAUDE_CODE_OAUTH_TOKEN: 'connected-oauth-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    });
  });

  it('prefers Claude subscription OAuth when multiple Claude-compatible connected services are present', async () => {
    const isolateClaudeRuntimeAuthEnv = readRuntimeAuthEnvIsolator(await import('./index.js'));
    const env = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'anthropic', profileId: 'api-key' },
        { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
      ]),
      ANTHROPIC_API_KEY: 'ambient-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'connected-oauth-token',
      CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    };

    const result = isolateClaudeRuntimeAuthEnv(env);

    expect(result).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'connected-oauth-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    });
  });

  it('preserves only materialized Anthropic API-key auth for connected Anthropic sessions', async () => {
    const isolateClaudeRuntimeAuthEnv = readRuntimeAuthEnvIsolator(await import('./index.js'));
    const env = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'anthropic', profileId: 'api-key' },
      ]),
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['ANTHROPIC_API_KEY']),
      ANTHROPIC_API_KEY: 'materialized-api-key',
      ANTHROPIC_AUTH_TOKEN: 'ambient-auth-token',
      CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    };

    const result = isolateClaudeRuntimeAuthEnv(env);

    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'materialized-api-key',
      CUSTOM_RUNTIME_ENV: 'keep',
    });
  });

  it('uses Claude subscription auth when multiple connected-service selections are present', async () => {
    const isolateClaudeRuntimeAuthEnv = readRuntimeAuthEnvIsolator(await import('./index.js'));
    const env = {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'anthropic', profileId: 'api-key' },
        { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
      ]),
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]),
      ANTHROPIC_API_KEY: 'materialized-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'materialized-oauth-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    };

    const result = isolateClaudeRuntimeAuthEnv(env);

    expect(result).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'materialized-oauth-token',
      CUSTOM_RUNTIME_ENV: 'keep',
    });
  });

  it('reports Claude runtime auth key presence without exposing values', async () => {
    const resolveClaudeRuntimeAuthEnvDiagnostic = readRuntimeAuthEnvDiagnosticResolver(await import('./index.js'));

    const diagnostic = resolveClaudeRuntimeAuthEnvDiagnostic({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'auth-secret',
      ANTHROPIC_OAUTH_TOKEN: 'oauth-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-secret',
      CLAUDE_CODE_SETUP_TOKEN: 'claude-setup-secret',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-secret',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
      CLAUDE_CONFIG_DIR: '/Users/test/.claude',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"kind":"profile"}]',
    });

    expect(diagnostic).toEqual({
      presentAuthEnvKeys: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_OAUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
        'CLAUDE_CODE_OAUTH_SCOPES',
        'CLAUDE_CODE_SETUP_TOKEN',
        'CLAUDE_CONFIG_DIR',
      ],
      hasAnthropicApiKey: true,
      hasAnthropicAuthToken: true,
      hasAnthropicOauthToken: true,
      hasClaudeCodeOauthToken: true,
      hasClaudeCodeSetupToken: true,
      hasClaudeCodeOauthRefreshToken: true,
      hasClaudeCodeOauthScopes: true,
      hasClaudeConfigDir: true,
      hasHappierConnectedServiceSelections: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
    expect(JSON.stringify(diagnostic)).not.toContain('/Users/test/.claude');
  });
});
