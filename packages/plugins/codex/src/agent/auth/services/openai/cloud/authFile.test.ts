import { describe, expect, it } from 'vitest';

import { buildCodexCloudAuthFile } from './authFile.js';

describe('buildCodexCloudAuthFile', () => {
  it('builds access-only host-managed ChatGPT auth with flat and nested token fields', () => {
    expect(buildCodexCloudAuthFile({
      accessToken: 'access-token',
      idToken: 'id-token',
      accountId: 'account-id',
      lastRefreshIso: '2026-06-06T13:15:00.000Z',
    })).toEqual({
      auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null,
      access_token: 'access-token',
      refresh_token: '',
      id_token: 'id-token',
      account_id: 'account-id',
      tokens: {
        access_token: 'access-token',
        refresh_token: '',
        id_token: 'id-token',
        account_id: 'account-id',
      },
      last_refresh: '2026-06-06T13:15:00.000Z',
    });
  });

  it('uses the access token for required native token metadata while preserving an absent account id', () => {
    expect(buildCodexCloudAuthFile({
      accessToken: 'access-token',
      idToken: null,
      accountId: null,
      lastRefreshIso: '2026-06-06T13:15:00.000Z',
    })).toMatchObject({
      id_token: 'access-token',
      refresh_token: '',
      account_id: null,
      tokens: {
        id_token: 'access-token',
        refresh_token: '',
        account_id: null,
      },
    });
  });
});
