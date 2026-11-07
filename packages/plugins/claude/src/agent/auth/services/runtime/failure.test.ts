import { createClaudeConnectedServiceRuntimeAuthAdapter } from './failure.js';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '../native/scopes.js';

describe('canonical Claude failure evidence', () => {
  it.each([
    { entry: 'assistant', text: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)", resetAtMs: Date.parse('2026-11-09T15:00:00Z') },
    { entry: 'result', text: "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)", resetAtMs: Date.parse('2026-11-09T15:00:00Z') },
    { entry: 'result', text: "You've hit your weekly limit · resets when available", resetAtMs: null },
  ] as const)('classifies the native SDK $entry weekly failure with its provider reset', ({ entry, text, resetAtMs }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-07T09:00:00Z'));
    try {
      const error = entry === 'assistant'
        ? { type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text }] } }
        : { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text] };
      expect(createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        selection: { serviceId: 'happier.agent.claude/claude-subscription', profileId: 'issued-profile', groupId: 'issued-pool' },
        error,
      })).toMatchObject({ kind: 'usage_limit', limitCategory: 'usage_limit', resetsAtMs: resetAtMs,
        serviceId: 'happier.agent.claude/claude-subscription', profileId: 'issued-profile', groupId: 'issued-pool' });
    } finally { clock.mockRestore(); }
  });

  it('retains source organization with the selected provider user', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./failure.js');
    expect(classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'happier.agent.claude/claude-subscription', profileId: 'selected', groupId: null,
      sourceProviderAccountId: 'provider-user', sourceProviderOrganizationId: 'organization-a',
      error: 'usage limit reached',
    })).toMatchObject({ sourceProviderAccountId: 'provider-user', sourceProviderOrganizationId: 'organization-a' });
  });

  it.each([
    [{ usageLimit: { v: 1, resetAtMs: null, retryAfterMs: 1500, quotaScope: 'provider',
      recoverability: 'wait', limitCategory: 'capacity' } }, 'capacity'],
    [{ temporaryThrottle: { v: 1, retryAfterMs: 1500, recoverability: 'wait' } }, 'temporary_throttle'],
  ])('classifies normalized native diagnostics for the actual selected Account service (%s)', async (details, kind) => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./failure.js');
    expect(createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
      target: { agentId: 'claude', targetId: 'run-current' },
      selection: { kind: 'profile', serviceId: 'happier.agent.claude/anthropic', profileId: 'current' },
      error: { code: 'claude_provider_failure', details },
    })).toMatchObject({ kind, serviceId: 'happier.agent.claude/anthropic', profileId: 'current',
      groupId: null, retryAfterMs: 1500, source: 'structured_provider_error' });
  });

  it('retains typed temporary-throttle evidence without inventing account identity', async () => {
    const { classifyClaudeConnectedServiceRuntimeAuthFailure } = await import('./failure.js');
    expect(classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'happier.agent.claude/claude-subscription', profileId: null, groupId: null,
      error: { code: 'claude_provider_throttle' },
      normalizedDetails: { temporaryThrottle: { v: 1, retryAfterMs: 1500, recoverability: 'wait' } },
    })).toMatchObject({ kind: 'temporary_throttle', limitCategory: 'temporary_throttle',
      quotaScope: 'provider', retryAfterMs: 1500, profileId: null, groupId: null,
      source: 'structured_provider_error' });
  });

  it('does not promote malformed normalized diagnostic facts into recovery evidence', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./failure.js');
    expect(createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
      target: { agentId: 'claude' },
      selection: { serviceId: 'happier.agent.claude/anthropic', profileId: 'current' },
      error: { code: 'claude_provider_failure', details: {
        usageLimit: { v: 1, limitCategory: 'capacity' },
        temporaryThrottle: { v: 1, retryAfterMs: '1500', recoverability: 'wait' },
      } },
    })).toBeNull();
  });
});

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

type ClaudeNativeAuthCodec = ReturnType<
  (typeof import('./failure.js'))['createClaudeConnectedAccountNativeAuthCodec']
>;

function createNativeAuthHarness(params: Readonly<{
  codec: ClaudeNativeAuthCodec;
  credential: Parameters<ClaudeNativeAuthCodec['materialize']>[0]['credential'];
  selection: Parameters<ClaudeNativeAuthCodec['materialize']>[0]['selection'];
}>) {
  const files: Record<string, Uint8Array> = Object.create(null);
  const inspectNativeAuth = async () => params.codec.inspect({
    credential: params.credential,
    selection: params.selection,
    files,
  });
  const materializeNativeAuth = async () => {
    Object.assign(files, params.codec.materialize({
      credential: params.credential,
      selection: params.selection,
    }).files);
    return await inspectNativeAuth();
  };
  return { files, inspectNativeAuth, materializeNativeAuth };
}

describe('Claude runtime auth service classification', () => {
  it('classifies unnamed provider 429 failures without requiring an SDK event envelope', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const result = createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
      target: { agentId: 'claude' },
      selection: { serviceId: 'claude-subscription', activeProfileId: 'team', groupId: 'coders' },
      error: { status: 429, error: { type: 'rate_limit_error', retryAfterMs: 1500 } },
    });
    expect(result).toMatchObject({ kind: 'usage_limit', retryAfterMs: 1500 });
    expect(result?.providerLimitId).toBeNull();
  });
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

  it('proves a current direct profile locally with exact native material when organization is unknown', async () => {
    const { createClaudeConnectedAccountNativeAuthCodec } = await import('./failure.js');
    const codec = createClaudeConnectedAccountNativeAuthCodec();
    const credential = createClaudeSubscriptionRecord('team');
    const materialized = codec.materialize({ credential, selection: {
      groupId: 'initial-only', activeProfileId: 'team', groupGeneration: 1,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    } });
    const files = { '.credentials.json': materialized.files['.credentials.json'],
      '.claude.json': new TextEncoder().encode(JSON.stringify({
        oauthAccount: { accountUuid: 'team-account', organizationUuid: 'native-context-unattested' },
      })),
    };
    const selection = { kind: 'profile' as const, profileId: 'team',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' };
    expect(codec.inspect({ credential, selection, files })).toMatchObject({ status: 'verified',
      providerAccountId: 'team-account', credentialRevision: selection.credentialRevision,
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), proofStrength: 'exact', source: 'materialized_native_auth',
    });
    expect(codec.inspect({ credential, selection, files })).not.toHaveProperty('providerOrganizationId');
    expect(codec.inspect({ credential, selection: { ...selection, profileId: 'another-profile' }, files })).toMatchObject({ status: 'unavailable' });
    expect(codec.inspect({ credential, selection: { ...selection, credentialRevision: null }, files })).toMatchObject({ status: 'unavailable' });
    expect(codec.inspect({ credential, selection, files: { ...files,
      '.credentials.json': new TextEncoder().encode(JSON.stringify({ claudeAiOauth: { accessToken: 'different-access', scopes: [] } })),
    } })).toMatchObject({ status: 'unavailable' });
    expect(codec.inspect({ credential, selection, files: { ...files,
      '.claude.json': new TextEncoder().encode(JSON.stringify({ oauthAccount: { accountUuid: 'another-user' } })),
    } })).toMatchObject({ status: 'unavailable' });
  });

  it('reconciles and verifies the actual native organization without retaining another context cache', async () => {
    const { createClaudeConnectedAccountNativeAuthCodec } = await import('./failure.js');
    const codec = createClaudeConnectedAccountNativeAuthCodec();
    const base = createClaudeSubscriptionRecord('team');
    if (base.kind !== 'oauth') throw new Error('Expected OAuth fixture');
    const credential = { ...base, oauth: { ...base.oauth, raw: { claudeAiOauth: { organizationUuid: 'organization-a' } } } };
    const selection = { groupId: 'coders', activeProfileId: 'team', groupGeneration: 12,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' };
    const initial = codec.materialize({ credential, selection });
    const decode = (files: Readonly<Record<string, Uint8Array>>) => {
      const bytes = files['.claude.json'];
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    };
    expect(decode(initial.files)).toMatchObject({ oauthAccount: {
      accountUuid: 'team-account', organizationUuid: 'organization-a', emailAddress: 'team@example.com',
    } });
    const existingRoot = { ...decode(initial.files), theme: 'light', projects: { project: { hasTrustDialogAccepted: true } },
      modelAccessCache: { 'account.flag': true }, additionalModelOptionsCache: { allowed: true } };
    const files = { ...initial.files, '.claude.json': new TextEncoder().encode(JSON.stringify(existingRoot)) };
    const same = codec.materialize({ credential, selection, files });
    expect(decode(same.files)).toMatchObject(existingRoot);
    const tierChanged = { ...credential, oauth: { ...credential.oauth,
      raw: { claudeAiOauth: { organizationUuid: 'organization-a', subscriptionType: 'max' } },
    } };
    expect(decode(codec.materialize({ credential: tierChanged, selection, files }).files)).not.toHaveProperty('modelAccessCache');

    const changed = { ...credential, oauth: { ...credential.oauth, raw: { claudeAiOauth: { organizationUuid: 'organization-b' } } } };
    const next = codec.materialize({ credential: changed, selection, files });
    expect(decode(next.files)).toMatchObject({ theme: 'light', projects: existingRoot.projects,
      oauthAccount: { accountUuid: 'team-account', organizationUuid: 'organization-b' } });
    expect(decode(next.files)).not.toHaveProperty('modelAccessCache');
    expect(decode(next.files)).not.toHaveProperty('additionalModelOptionsCache');
    expect(codec.inspect({ credential: changed, selection, files: next.files })).toMatchObject({ status: 'verified' });
    expect(codec.inspect({ credential: changed, selection, files: {
      ...next.files, '.claude.json': files['.claude.json'],
    } })).toMatchObject({ status: 'unavailable' });
    const unknown = { ...credential, oauth: { ...credential.oauth, raw: null } };
    const local = codec.materialize({ credential: unknown, selection, files });
    expect(decode(local.files)).not.toHaveProperty('oauthAccount.organizationUuid');
    expect(codec.inspect({ credential: unknown, selection, files: local.files })).toMatchObject({ status: 'verified' });
  });

  it('hot-applies Claude subscription group auth by rewriting the shared config dir', async () => {
    await withLinuxPlatform(async () => {
      const {
        createClaudeConnectedAccountNativeAuthCodec,
        createClaudeConnectedServiceRuntimeAuthAdapter,
      } = await import('./index.js');
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
      const credential = createClaudeSubscriptionRecord('team');
      const selection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      };
      const { files, materializeNativeAuth } = createNativeAuthHarness({
        codec: createClaudeConnectedAccountNativeAuthCodec(),
        credential,
        selection,
      });

      await expect(adapter.materializeActiveProfile({ target: { agentId: 'claude' }, selection }))
        .resolves.toMatchObject({ supported: true, supportsInTurnApply: true });

      expect(adapter.canHotApply({
        target: { agentId: 'claude' },
        selection,
        materializeNativeAuth,
      })).toEqual({
        supported: true,
      });

      await expect(adapter.hotApply({
        target: { agentId: 'claude' },
        selection,
        materializeNativeAuth,
      })).resolves.toMatchObject({
        applied: true,
        reason: 'claude_shared_group_auth_surface_rewritten',
        verification: {
          status: 'verified',
          providerAccountId: 'team-account',
          activeAccountId: 'team@example.com',
          sharedAuthSurfaceId: 'coders',
          proofStrength: 'exact',
          source: 'shared_group_auth_surface',
          reason: 'claude_shared_group_auth_surface_rewritten',
          generationApplication: {
            serviceId: 'happier.agent.claude/claude-subscription',
            groupId: 'coders',
            profileId: 'team',
            generation: 12,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      });

      const credentials = JSON.parse(new TextDecoder().decode(files['.credentials.json'])) as {
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

    expect(adapter.canHotApply({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'claude-subscription',
        profileId: 'team',
      },
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
      },
    })).toEqual({
      supported: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_resume',
    });
  });

  it('does not hot-apply token-backed Claude subscription groups through the shared config dir', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    const selection = {
      serviceId: 'claude-subscription',
      groupId: 'coders',
      activeProfileId: 'setup',
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
      const {
        createClaudeConnectedAccountNativeAuthCodec,
        createClaudeConnectedServiceRuntimeAuthAdapter,
      } = await import('./index.js');
      const record = createClaudeSubscriptionRecord('team');
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();

      const selection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      };
      const { inspectNativeAuth, materializeNativeAuth } = createNativeAuthHarness({
        codec: createClaudeConnectedAccountNativeAuthCodec(),
        credential: record,
        selection,
      });
      await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection, materializeNativeAuth })).resolves.toMatchObject({
        applied: true,
      });

      const result = await adapter.verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection,
        inspectNativeAuth,
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
          serviceId: 'happier.agent.claude/claude-subscription',
          groupId: 'coders',
          profileId: 'team',
          generation: 12,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
          credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
    });
  });

  it('returns restart recovery when the host rejects superseded materialization', async () => {
    const { createClaudeConnectedServiceRuntimeAuthAdapter } = await import('./index.js');
    await expect(createClaudeConnectedServiceRuntimeAuthAdapter().hotApply({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'happier.agent.claude/claude-subscription',
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
      materializeNativeAuth: async () => ({
        status: 'unavailable',
        retryable: true,
        reason: 'credential_revision_superseded',
      }),
    })).resolves.toEqual({
      applied: false,
      reason: 'credential_revision_superseded',
      recovery: 'restart_resume',
    });
  });

  it.each([
    ['credential revision ABA', { groupGeneration: 12, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }],
    ['group generation change', { groupGeneration: 13, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }],
  ])('does not adopt same credential bytes across a %s', async (_label, desired) => {
    await withLinuxPlatform(async () => {
      const {
        createClaudeConnectedAccountNativeAuthCodec,
        createClaudeConnectedServiceRuntimeAuthAdapter,
      } = await import('./index.js');
      const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
      const credential = createClaudeSubscriptionRecord('team');
      const baseSelection = {
        groupId: 'coders',
        activeProfileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      };
      const codec = createClaudeConnectedAccountNativeAuthCodec();
      const { files, materializeNativeAuth } = createNativeAuthHarness({ codec, credential, selection: baseSelection });
      await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection: baseSelection, materializeNativeAuth }))
        .resolves.toMatchObject({ applied: true });
      await expect(adapter.verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection: { ...baseSelection, ...desired },
        inspectNativeAuth: async () => codec.inspect({
          credential,
          selection: { ...baseSelection, ...desired },
          files,
        }),
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
      const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
        target: { agentId: 'claude' },
        selection: {},
        inspectNativeAuth: async () => ({
          status: 'verified',
          providerAccountId: 'ambient-account',
        }),
      });

      expect(result).toEqual({
        status: 'unavailable',
        retryable: false,
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


describe('Claude issued request attribution', () => {
  it('retains explicit unknown request identity and separate provider organization proof', () => {
    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    expect(adapter.classifyRuntimeAuthFailure({target: {agentId: 'claude'},
      selection: {serviceId: 'happier.agent.claude/claude-subscription', activeProfileId: 'issued-profile',
        sourceProviderAccountId: null, sourceProviderOrganizationId: null, providerReportedOrganizationId: 'org-proof'},
      error: {error: 'rate_limit_error', apiErrorStatus: 429, message: 'Usage limit reached'},
    })).toMatchObject({profileId: 'issued-profile', sourceProviderAccountId: null,
      sourceProviderOrganizationId: null, providerReportedOrganizationId: 'org-proof'});
  });
});
