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

describe('geminiConnectedServiceQuotaFetcherContribution', () => {
  it('exports the Gemini quota fetcher through the plugin-owned auth/services surface', () => {
    const fetcher = geminiConnectedServiceQuotaFetcherContribution.createFetcher();

    expect(geminiConnectedServiceQuotaFetcherContribution.id).toBe('gemini');
    expect(fetcher.serviceId).toBe('gemini');
  });

  it('returns a quota_unknown placeholder snapshot instead of null so the UI can render quota unavailable', async () => {
    const now = 1_000_000;
    const fetcher = createGeminiQuotaFetcher();

    const snapshot = await fetcher.loadQuota({
      record: makeGeminiOauthRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({
      v: 1,
      serviceId: 'gemini',
      profileId: 'work',
      fetchedAt: now,
    });
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
});
