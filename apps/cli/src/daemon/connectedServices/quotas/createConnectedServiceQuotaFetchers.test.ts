import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createConnectedServiceQuotaFetchers } from './createConnectedServiceQuotaFetchers';

describe('createConnectedServiceQuotaFetchers', () => {
  it('defaults staleAfterMs to 30 minutes when unset', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async (_input: unknown) => ({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 5, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 10, reset_at: 1_700_100_000 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({});
    const openAiFetcher = fetchers.find((fetcher) => fetcher.serviceId === 'openai-codex');
    expect(openAiFetcher).toBeTruthy();

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const snapshot = await openAiFetcher!.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.staleAfterMs).toBe(30 * 60_000);
  });
});
