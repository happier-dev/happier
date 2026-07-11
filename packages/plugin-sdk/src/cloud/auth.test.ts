import { describe, expect, it } from 'vitest';

import * as cloudAuth from './auth.js';
import {
  buildConnectedServiceOauthAuthEntry,
  buildConnectedServiceCredentialRecord,
  classifyProviderLimitEvidence,
  defineConnectedServiceAuthMaterialization,
  readConnectedServiceCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  requireConnectedServiceTokenCredentialRecord,
} from './auth.js';

describe('connected-service auth materialization helpers', () => {
  it('keeps provider-specific env materialization facts out of the SDK helper surface', () => {
    expect(Object.keys(cloudAuth)).not.toEqual(expect.arrayContaining([
      'readGoogleGenAiVertexMetadataEnv',
      'resolveGoogleGenAiConnectedServiceTokenEnv',
    ]));
  });

  it('builds service selection and materialization input helpers from provider-owned bindings', () => {
    const helpers = defineConnectedServiceAuthMaterialization([
      { serviceId: 'openai-codex', inputKey: 'openaiCodex' },
      { serviceId: 'gemini', inputKey: 'gemini' },
    ] as const);
    const record = { credential: 'record' };

    expect(helpers.serviceIds).toEqual(['openai-codex', 'gemini']);
    expect(helpers.readConnectedServiceId('gemini')).toBe('gemini');
    expect(helpers.readConnectedServiceId({ serviceId: 'openai-codex' })).toBe('openai-codex');
    expect(helpers.readConnectedServiceId({ serviceId: 'github' })).toBeNull();
    expect(helpers.createAuthMaterializationInput('openai-codex', record)).toEqual({
      openaiCodex: record,
    });
    expect(helpers.createAuthMaterializationInput('github', record)).toEqual({});
  });

  it('centralizes credential record reading and kind-specific requirements', () => {
    const now = 1_700_000_000_000;
    const token = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'token',
      token: {
        token: 'openai-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const oauth = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'codex-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        providerAccountId: 'account-id',
        providerEmail: 'codex@example.com',
        scope: 'openid profile',
        tokenType: 'Bearer',
      },
    });
    const oauthWithoutExpiry = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-oauth',
      kind: 'oauth',
      oauth: {
        accessToken: 'gemini-access-token',
        refreshToken: 'gemini-refresh-token',
        idToken: null,
        providerAccountId: null,
        providerEmail: null,
        scope: null,
        tokenType: null,
      },
    });

    expect(readConnectedServiceCredentialRecord(token)).toBe(token);
    expect(readConnectedServiceCredentialRecord(null)).toBeNull();
    expect(readConnectedServiceCredentialRecord({
      v: 1,
      serviceId: 'openai',
      profileId: 'api-key',
      kind: 'token',
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      token: {
        token: '   ',
        providerAccountId: null,
        providerEmail: null,
        raw: null,
      },
    })).toBeNull();
    expect(requireConnectedServiceTokenCredentialRecord(token)).toBe(token);
    expect(() => requireConnectedServiceTokenCredentialRecord(oauth, {
      message: 'OAuth credentials are not supported here.',
    })).toThrow('OAuth credentials are not supported here.');
    const oauthWithExpiry = requireConnectedServiceOauthCredentialRecordWithExpiry(oauth);
    expect(oauthWithExpiry).toBe(oauth);
    expect(() => requireConnectedServiceOauthCredentialRecordWithExpiry(oauthWithoutExpiry))
      .toThrow('Expected oauth credential record with expiresAt for gemini/gemini-oauth');
    expect(buildConnectedServiceOauthAuthEntry(oauthWithExpiry)).toEqual({
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: now + 60_000,
      accountId: 'account-id',
    });
  });
});

describe('provider limit evidence classification', () => {
  it('classifies nested provider capacity payloads and Error instances through one SDK owner', () => {
    expect(classifyProviderLimitEvidence({
      turn: {
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'other',
        },
      },
    })).toBe('capacity');
    expect(classifyProviderLimitEvidence(
      new Error('Selected model is at capacity. Please try a different model.'),
    )).toBe('capacity');
  });

  it('preserves structured status and provider-code classifications', () => {
    expect(classifyProviderLimitEvidence({ error: { data: { status: 429 } } })).toBe('rate_limit');
    expect(classifyProviderLimitEvidence({ code: 'usage_limit_reached' })).toBe('usage_limit');
    expect(classifyProviderLimitEvidence({ message: 'account disabled' })).toBe('disabled');
    expect(classifyProviderLimitEvidence({ message: 'quota limit: 100 remaining: 95' })).toBe('unknown');
  });

  it('does not infer provider capacity from unrelated unavailable metadata', () => {
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { status: 429 },
    })).toBe('validation_failed');
    expect(classifyProviderLimitEvidence({
      status: 400,
      request: { note: 'Provider unavailable translation key' },
    })).toBe('validation_failed');
    expect(classifyProviderLimitEvidence({ message: 'Provider unavailable' })).toBe('capacity');
  });
});
