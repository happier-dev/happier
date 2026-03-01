import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { materializeClaudeSubscriptionConnectedServiceAuth } from './materializeClaudeSubscriptionConnectedServiceAuth';

describe('materializeClaudeSubscriptionConnectedServiceAuth', () => {
  it('maps token credentials to CLAUDE_CODE_SETUP_TOKEN', () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-oat01-123', providerAccountId: null, providerEmail: null },
    });

    const res = materializeClaudeSubscriptionConnectedServiceAuth({ record });
    expect(res.env).toMatchObject({ CLAUDE_CODE_SETUP_TOKEN: 'sk-ant-oat01-123' });
    expect(res.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('maps oauth credentials to CLAUDE_CODE_OAUTH_TOKEN', () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const res = materializeClaudeSubscriptionConnectedServiceAuth({ record });
    expect(res.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'access' });
    expect(res.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});
