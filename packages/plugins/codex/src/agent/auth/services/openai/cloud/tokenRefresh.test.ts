import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { refreshCodexChatGptTokensForBridge } from './tokenRefresh.js';

describe('refreshCodexChatGptTokensForBridge', () => {
  it('uses the host OAuth refresher, persists rotation, and returns no refresh token to Codex', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });
    const refreshOauthTokens = vi.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
      idToken: 'new-id',
      expiresAt: 3000,
    }));
    const persistUpdatedRecord = vi.fn(async () => {});

    const result = await refreshCodexChatGptTokensForBridge({
      record,
      chatgptPlanType: 'plus',
      now: 2500,
      refreshOauthTokens,
      persistUpdatedRecord,
    });

    expect(refreshOauthTokens).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 2500,
    });
    expect(result.codexResponse).toEqual({
      accessToken: 'new-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'plus',
    });
    expect(result.codexResponse).not.toHaveProperty('refreshToken');
    expect(persistUpdatedRecord).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'work',
      kind: 'oauth',
    }));
    expect(result.updatedRecord.kind).toBe('oauth');
    if (result.updatedRecord.kind === 'oauth') {
      expect(result.updatedRecord.oauth.refreshToken).toBe('rotated-refresh');
      expect(result.updatedRecord.oauth.accessToken).toBe('new-access');
    }
  });
});
