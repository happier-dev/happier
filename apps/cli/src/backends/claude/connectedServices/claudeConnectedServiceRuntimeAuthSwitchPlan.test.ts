import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { resolveClaudeConnectedServiceRuntimeAuthSwitchPlan } from './claudeConnectedServiceRuntimeAuthSwitchPlan';

describe('resolveClaudeConnectedServiceRuntimeAuthSwitchPlan', () => {
  it('requires restart/rematerialize for Anthropic API-key credentials', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'anthropic',
      profileId: 'api',
      kind: 'token',
      token: { token: 'sk-ant', providerAccountId: null, providerEmail: null },
    });

    expect(resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(record)).toEqual({
      supportsHotApply: false,
      recovery: 'restart_rematerialize',
      envKeys: ['ANTHROPIC_API_KEY'],
      materialization: 'anthropic_api_key',
    });
  });

  it('supports native credential-file hot apply for Claude subscription setup-token credentials', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });

    expect(resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(record)).toEqual({
      supportsHotApply: true,
      recovery: 'shared_group_auth_surface_rewrite',
      envKeys: ['CLAUDE_CONFIG_DIR'],
      materialization: 'claude_code_native_credentials_file',
    });
  });

  it('supports shared-home hot apply with native credential-file materialization for Claude subscription OAuth credentials', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(record)).toEqual({
      supportsHotApply: true,
      recovery: 'shared_group_auth_surface_rewrite',
      envKeys: ['CLAUDE_CONFIG_DIR'],
      materialization: 'claude_code_native_credentials_file',
    });
  });
});
