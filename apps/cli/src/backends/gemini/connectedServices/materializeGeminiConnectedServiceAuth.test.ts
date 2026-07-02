import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceCredentialRecordV1Schema,
  buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

describe('materializeGeminiConnectedServiceAuth', () => {
  it('writes OAuth credentials under the isolated connected-service home', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-p1',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'gemini-access',
        refreshToken: 'gemini-refresh',
        idToken: 'gemini-id-token',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        tokenType: 'Bearer',
        providerAccountId: 'google-account',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeGeminiConnectedServiceAuth({ rootDir, record });

    const homeDir = join(rootDir, 'home');
    expect(result.env).toMatchObject({
      HOME: homeDir,
      GEMINI_CLI_HOME: homeDir,
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
    });
    const raw = await readFile(join(homeDir, '.gemini', 'oauth_creds.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      access_token: 'gemini-access',
      refresh_token: 'gemini-refresh',
      id_token: 'gemini-id-token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      token_type: 'Bearer',
      expires_at: now + 60_000,
    });
  });

  it('materializes Vertex AI env from connected-service metadata without treating OAuth tokens as API keys', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      ...buildConnectedServiceCredentialRecord({
        now: 1_700_000_000_000,
        serviceId: 'gemini',
        profileId: 'vertex-profile',
        kind: 'oauth',
        expiresAt: 1_700_000_060_000,
        oauth: {
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          idToken: null,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          tokenType: 'Bearer',
          providerAccountId: 'google-account',
          providerEmail: 'user@example.com',
        },
      }),
      oauth: {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
        idToken: null,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        tokenType: 'Bearer',
        providerAccountId: 'google-account',
        providerEmail: 'user@example.com',
        raw: {
          vertexAi: {
            project: 'vertex-project',
            location: 'us-central1',
          },
        },
      },
    });

    const result = await materializeGeminiConnectedServiceAuth({ rootDir, record });

    expect(result.env).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    });
    expect(result.env.GEMINI_API_KEY).toBeUndefined();
    expect(result.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it('materializes gateway auth metadata from connected-service metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-gemini-auth-'));
    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      ...buildConnectedServiceCredentialRecord({
        now: 1_700_000_000_000,
        serviceId: 'gemini',
        profileId: 'gateway-profile',
        kind: 'token',
        token: {
          token: 'gateway-token',
          providerAccountId: null,
          providerEmail: null,
        },
      }),
      token: {
        token: 'gateway-token',
        providerAccountId: null,
        providerEmail: null,
        raw: {
          gateway: {
            baseUrl: 'https://gateway.example.test/v1',
            headers: {
              Authorization: 'Bearer gateway-token',
              'X-Gateway-Account': 'acct-1',
            },
          },
        },
      },
    });

    const result = await materializeGeminiConnectedServiceAuth({ rootDir, record });

    expect(result.env.HAPPIER_GEMINI_ACP_AUTH_METHOD).toBe('gateway');
    expect(JSON.parse(result.env.HAPPIER_GEMINI_ACP_AUTH_META ?? '{}')).toEqual({
      gateway: {
        baseUrl: 'https://gateway.example.test/v1',
        headers: {
          Authorization: 'Bearer gateway-token',
          'X-Gateway-Account': 'acct-1',
        },
      },
    });
    expect(result.env.GEMINI_API_KEY).toBeUndefined();
    expect(result.env.GOOGLE_API_KEY).toBeUndefined();
  });
});
