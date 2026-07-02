import { describe, expect, it } from 'vitest';

import { buildCodexCloudAuthFile } from './authFile.js';

describe('buildCodexCloudAuthFile', () => {
  it('builds the ChatGPT auth file with flat and nested token fields', () => {
    expect(buildCodexCloudAuthFile({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: 'id-token',
      accountId: 'account-id',
      lastRefreshIso: '2026-06-06T13:15:00.000Z',
    })).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      account_id: 'account-id',
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        account_id: 'account-id',
      },
      last_refresh: '2026-06-06T13:15:00.000Z',
    });
  });

  it('preserves nullable OpenAI identity fields from connected-service credentials', () => {
    expect(buildCodexCloudAuthFile({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: null,
      accountId: null,
      lastRefreshIso: '2026-06-06T13:15:00.000Z',
    })).toMatchObject({
      id_token: null,
      account_id: null,
      tokens: {
        id_token: null,
        account_id: null,
      },
    });
  });
});
