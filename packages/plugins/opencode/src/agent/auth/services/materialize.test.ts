import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { buildOpenCodeAuthContent, materializeOpenCodeAuthEnvironment } from './materialize.js';

describe('OpenCode auth materialization', () => {
  it('maps OpenAI Codex OAuth and Anthropic token credentials into OpenCode auth content', () => {
    const now = 1000;
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_123',
        providerEmail: 'alice@example.com',
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'anthropic-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(JSON.parse(buildOpenCodeAuthContent({
      openaiCodex,
      anthropic,
    }))).toEqual({
      openai: {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: now + 60_000,
        accountId: 'acct_123',
      },
      anthropic: {
        type: 'api',
        key: 'anthropic-token',
      },
    });
  });

  it('emits only process env consumed by the shared materialization substrate', () => {
    const now = 2000;
    const openai = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'openai-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(materializeOpenCodeAuthEnvironment({
      openai,
      managedServerStatePath: '/tmp/opencode-state.json',
    })).toEqual({
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          openai: {
            type: 'api',
            key: 'openai-token',
          },
        }),
        HAPPIER_OPENCODE_SERVER_STATE_PATH: '/tmp/opencode-state.json',
      },
    });
  });

  it('fails closed when a service is provided with an unsupported credential kind', () => {
    const invalid = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(() => buildOpenCodeAuthContent({ openaiCodex: invalid })).toThrow(/oauth/i);
  });

  it('reports that Claude subscription OAuth needs setup-token materialization', () => {
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 2,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-account',
        providerEmail: 'claude@example.com',
      },
    });

    expect(() => buildOpenCodeAuthContent({ claudeSubscription })).toThrow(
      /Claude subscription OAuth credentials.*setup-token/,
    );
  });
});
