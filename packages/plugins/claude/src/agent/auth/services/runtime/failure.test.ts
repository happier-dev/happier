import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { writeClaudeCodeCredentialsFile } from '../native/credentials.js';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '../native/scopes.js';

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

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function withLinuxPlatform<T>(fn: () => Promise<T>): Promise<T> {
  if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
    return fn();
  }
  Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  });
}

function createClaudeSubscriptionRecord(profileId = 'team') {
  return buildConnectedServiceCredentialRecord({
    now: 1000,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'oauth',
    expiresAt: Date.now() + 60 * 60 * 1000,
    oauth: {
      accessToken: `${profileId}-access-placeholder`,
      refreshToken: `${profileId}-refresh-placeholder`,
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: `${profileId}-account`,
      providerEmail: `${profileId}@example.com`,
    },
  });
}

function createClaudeSubscriptionSetupTokenRecord(profileId = 'setup') {
  return buildConnectedServiceCredentialRecord({
    now: 1000,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'token',
    token: {
      token: `${profileId}-setup-token`,
      providerAccountId: `${profileId}-account`,
      providerEmail: `${profileId}@example.com`,
    },
  });
}

describe('Claude runtime auth service classification', () => {
  it('attaches source provider account identity and group generation to runtime usage-limit classifications', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();

    const result = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'claude-subscription',
        activeProfileId: 'team',
        groupId: 'coders',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        sourceProviderAccountId: 'live-account',
        sourceAccountLabel: 'live@example.com',
        record: createClaudeSubscriptionRecord('team'),
      },
      error: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'weekly',
          utilization: 100,
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'team',
      groupId: 'coders',
      groupGeneration: 12,
      expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      sourceProviderAccountId: 'live-account',
      sourceAccountLabel: 'live@example.com',
    });
  });

  it('hot-applies Claude subscription group auth by rewriting the shared config dir', async () => {
    await withLinuxPlatform(async () => {
      const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
      const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
      const selection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        record: createClaudeSubscriptionRecord('team'),
        targetMaterializedRoot: claudeConfigDir,
      };

      expect(adapter.canHotApply({
        target: { agentId: 'claude' },
        selection,
      })).toEqual({
        supported: true,
        mode: 'claude_subscription_shared_group_auth_surface_rewrite',
      });

      await expect(adapter.hotApply({
        target: { agentId: 'claude' },
        selection,
      })).resolves.toMatchObject({
        applied: true,
        reason: 'claude_shared_group_auth_surface_rewritten',
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        verification: {
          status: 'verified',
          providerAccountId: 'team-account',
          activeAccountId: 'team@example.com',
          sharedAuthSurfaceId: 'coders',
          proofStrength: 'exact',
          source: 'shared_group_auth_surface',
          reason: 'claude_shared_group_auth_surface_rewritten',
          generationApplication: {
            serviceId: 'claude-subscription',
            groupId: 'coders',
            profileId: 'team',
            generation: 12,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      });

      const credentials = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; refreshToken?: string };
      };
      expect(credentials.claudeAiOauth).toMatchObject({
        accessToken: 'team-access-placeholder',
      });
      expect(credentials.claudeAiOauth).not.toHaveProperty('refreshToken');
    });
  });

  it('keeps non-group Claude subscription and Anthropic auth on restart recovery without hot-apply subpaths', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));

    expect(adapter.canHotApply({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'claude-subscription',
        profileId: 'team',
        record: createClaudeSubscriptionRecord('team'),
      },
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    })).toEqual({
      supported: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });

    expect(adapter.canHotApply({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'anthropic',
        groupId: 'coders',
        record: { serviceId: 'anthropic' },
      },
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    })).toEqual({
      supported: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
  });

  it('does not hot-apply token-backed Claude subscription groups through the shared config dir', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));
    const selection = {
      serviceId: 'claude-subscription',
      groupId: 'coders',
      activeProfileId: 'setup',
      record: createClaudeSubscriptionSetupTokenRecord('setup'),
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    };

    expect(adapter.canHotApply({
      target: { agentId: 'claude' },
      selection,
    })).toEqual({
      supported: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
    await expect(adapter.hotApply({
      target: { agentId: 'claude' },
      selection,
    })).resolves.toEqual({
      applied: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
  });

  it('verifies exact Claude group epoch provenance plus native auth under the destination lock', async () => {
    await withLinuxPlatform(async () => {
      const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
      const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));
      const record = createClaudeSubscriptionRecord('team');
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();

      const selection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      };
      await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection })).resolves.toMatchObject({
        applied: true,
      });

      const result = await adapter.verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection,
      });

      expect(result).toEqual({
        status: 'verified',
        providerAccountId: 'team-account',
        activeAccountId: 'team@example.com',
        sharedAuthSurfaceId: 'coders',
        proofStrength: 'exact',
        source: 'shared_group_auth_surface',
        reason: 'claude_shared_group_auth_surface_rewritten',
        generationApplication: {
          serviceId: 'claude-subscription',
          groupId: 'coders',
          profileId: 'team',
          generation: 12,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
          credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
    });
  });

  it.each([
    ['credential revision ABA', { groupGeneration: 12, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }],
    ['group generation change', { groupGeneration: 13, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }],
  ])('does not adopt same credential bytes across a %s', async (_label, desired) => {
    await withLinuxPlatform(async () => {
      const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
      const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
      const baseSelection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        record: createClaudeSubscriptionRecord('team'),
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      };
      await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection: baseSelection }))
        .resolves.toMatchObject({ applied: true });
      await expect(adapter.verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection: { ...baseSelection, ...desired },
      })).resolves.toMatchObject({ status: 'unavailable' });
    });
  });

  it('fails closed for Claude shared-group hot apply selections without a generation', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    const selection = {
      serviceId: 'claude-subscription',
      groupId: 'coders',
      activeProfileId: 'team',
      record: createClaudeSubscriptionRecord('team'),
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
    };

    expect(adapter.canHotApply({
      target: { agentId: 'claude' },
      selection,
    })).toEqual({
      supported: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
    await expect(adapter.hotApply({
      target: { agentId: 'claude' },
      selection,
    })).resolves.toEqual({
      applied: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
  });

  it('does not treat healthy Claude subscription native credentials as runtime account adoption proof', async () => {
    await withLinuxPlatform(async () => {
      const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
      const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-auth-test-'));
      await writeClaudeCodeCredentialsFile({
        claudeConfigDir,
        payload: {
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            refreshToken: 'refresh-placeholder',
            expiresAt: Date.now() + 60 * 60 * 1000,
            scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
          },
        },
      });

      const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection: {},
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      });

      expect(result).toEqual({
        status: 'unavailable',
        retryable: true,
        reason: 'claude_code_runtime_account_adoption_unproven',
      });
    });
  });

  it('does not treat missing Claude materialized config dir as account adoption proof', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {},
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'missing_materialized_claude_config_dir',
    });
  });

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

  it('classifies Claude SDK api_error auth events that report 401 via error_status', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');

    const result = classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      error: {
        type: 'system',
        subtype: 'api_error',
        attempt: 1,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      },
    });

    expect(result).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
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

  it('classifies exact Claude temporary provider limiting StopFailure as retryable temporary throttle', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./index.js');

    const result = classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      error: {
        type: 'assistant_response',
        isApiErrorMessage: true,
        api_error_status: 429,
        message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      },
    });

    expect(result).toMatchObject({
      kind: 'temporary_throttle',
      limitCategory: 'rate_limit',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'main',
      providerLimitId: 'transient',
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
