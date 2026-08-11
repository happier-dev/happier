import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import { classifyClaudeCodeCredentialHealth } from './claudeCodeCredentialHealth';

describe('classifyClaudeCodeCredentialHealth', () => {
  it('accepts Claude subscription OAuth records with Claude Code scopes and refresh token', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(classifyClaudeCodeCredentialHealth(record)).toEqual({
      status: 'ok',
      missingScopes: [],
    });
  });

  it('fails closed when Claude subscription OAuth is missing Claude Code session scope', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: 'user:profile user:inference',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(classifyClaudeCodeCredentialHealth(record)).toEqual({
      status: 'missing_required_scope',
      missingScopes: ['user:sessions:claude_code'],
    });
  });

  it('accepts non-empty setup-token records as Claude Unified native auth', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: { token: 'setup-placeholder', providerAccountId: null, providerEmail: null },
    });

    expect(classifyClaudeCodeCredentialHealth(record)).toEqual({
      status: 'ok',
      missingScopes: [],
    });
  });
});
