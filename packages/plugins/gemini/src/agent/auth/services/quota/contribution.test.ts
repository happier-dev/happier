import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  createGeminiQuotaFetcher,
  geminiConnectedServiceQuotaFetcherContribution,
} from './contribution';

function makeGeminiOauthRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'gemini',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 3_600_000,
    oauth: {
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
      scope: null,
      tokenType: null,
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

function makeGeminiTokenRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'gemini',
    profileId: 'work',
    kind: 'token',
    token: {
      token: 'gemini-api-key',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

describe('geminiConnectedServiceQuotaFetcherContribution', () => {
  it('exports the Gemini quota fetcher through the plugin-owned auth/services surface', () => {
    const fetcher = geminiConnectedServiceQuotaFetcherContribution.createFetcher();

    expect(geminiConnectedServiceQuotaFetcherContribution.id).toBe('gemini');
    expect(fetcher.serviceId).toBe('gemini');
  });

  it('returns a public semantic quota_unknown snapshot for API-key or Vertex token credentials', async () => {
    const now = 1_000_000;
    const fetcher = createGeminiQuotaFetcher();

    const snapshot = await fetcher.loadQuota({
      record: makeGeminiTokenRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({
      v: 1,
      recordKey: {
        providerId: 'gemini',
        accountSubjectId: 'provisional:gemini:work',
        subjectKind: 'unknown',
        quotaScope: 'account',
      },
      providerId: 'gemini',
      accountSubject: {
        kind: 'provisionalLocalSubject',
        id: 'provisional:gemini:work',
        mergeKey: 'gemini:work',
      },
      observedAtMs: now,
      fetchedAtMs: now,
      source: 'connectedServiceProbe',
      confidence: 'unknown',
      state: 'loaded_data',
    });
    expect(snapshot).not.toHaveProperty('serviceId');
    expect(snapshot).not.toHaveProperty('profileId');
    expect(snapshot.meters).toHaveLength(1);
    expect(snapshot.meters[0]).toMatchObject({
      meterId: 'quota_unknown',
      status: 'unavailable',
      used: null,
      limit: null,
      utilizationPct: null,
      details: { code: 'quota_unknown' },
    });
  });

  it('does not treat stale OAuth records as supported Gemini quota credentials', async () => {
    const now = 1_000_000;
    const fetcher = createGeminiQuotaFetcher();

    await expect(fetcher.loadQuota({
      record: makeGeminiOauthRecord(now),
      now,
      signal: new AbortController().signal,
    })).resolves.toBeNull();
  });
});
