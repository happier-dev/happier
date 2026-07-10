import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES,
  createAntigravityAuthMaterializationInput,
  materializeAntigravityAuthEnvironment,
  readAntigravityConnectedServiceId,
} from './auth.js';

describe('Antigravity connected-service auth materialization', () => {
  it('materializes Gemini API-key token credentials for SDK mode without OAuth state', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'gemini',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(materializeAntigravityAuthEnvironment({
      rootDir: '/tmp/materialized-antigravity',
      gemini: record,
    })).resolves.toEqual({
      env: {
        HOME: '/tmp/materialized-antigravity/home',
        GEMINI_CLI_HOME: '/tmp/materialized-antigravity/home',
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        GEMINI_API_KEY: 'gemini-api-key',
        GOOGLE_API_KEY: 'gemini-api-key',
      },
    });
  });

  it('materializes Gemini Vertex token metadata using canonical Gemini env names for SDK mode', async () => {
    const apiKey = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'gemini',
      profileId: 'vertex',
      kind: 'token',
      token: {
        token: 'unused-token-placeholder',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const record = {
      ...apiKey,
      token: {
        ...apiKey.token,
        raw: {
          vertexAi: {
            project: 'vertex-project',
            location: 'us-central1',
          },
        },
      },
    };

    await expect(materializeAntigravityAuthEnvironment({
      rootDir: '/tmp/materialized-antigravity',
      gemini: record,
    })).resolves.toEqual({
      env: {
        HOME: '/tmp/materialized-antigravity/home',
        GEMINI_CLI_HOME: '/tmp/materialized-antigravity/home',
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        ANTIGRAVITY_AUTH_MODE: 'vertex',
        GOOGLE_GENAI_USE_VERTEXAI: '1',
        GOOGLE_CLOUD_PROJECT: 'vertex-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    });
  });

  it('keeps OAuth fail-closed because agy subscription auth is local-login backed', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'gemini',
      profileId: 'oauth',
      kind: 'oauth',
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(materializeAntigravityAuthEnvironment({
      rootDir: '/tmp/materialized-antigravity',
      gemini: record,
    })).resolves.toEqual({
      env: {},
      diagnostics: [{
        code: 'antigravity_gemini_oauth_not_portable_local_agy_login_required',
        providerId: 'antigravity',
        serviceId: 'gemini',
        severity: 'blocking',
      }],
    });
  });

  it('ignores malformed Gemini credential inputs through the shared credential parser', async () => {
    await expect(materializeAntigravityAuthEnvironment({
      rootDir: '/tmp/materialized-antigravity',
      gemini: {
        serviceId: 'gemini',
        profileId: 'broken',
        kind: 'token',
      },
    })).resolves.toEqual({ env: {} });
  });

  it('declares projection helpers without broadening Gemini setup ownership', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'gemini',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(readAntigravityConnectedServiceId({ serviceId: 'gemini' })).toBe('gemini');
    expect(readAntigravityConnectedServiceId({ serviceId: 'openai' })).toBeNull();
    expect(createAntigravityAuthMaterializationInput('gemini', record)).toEqual({ gemini: record });
    expect(createAntigravityAuthMaterializationInput('openai', record)).toEqual({});
    expect(ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'ANTIGRAVITY_AUTH_MODE',
      'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]);
  });
});
