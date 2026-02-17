import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createOpenAiCodexQuotaFetcher } from './openAiCodexQuotaFetcher';

describe('createOpenAiCodexQuotaFetcher', () => {
  it('fetches and parses ChatGPT wham usage into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: 1700000000 },
          secondary_window: { used_percent: 25, reset_at: 1700003600 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

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
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher({
      usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.planLabel).toBe('pro');
      expect(parsed.data.meters.map((m) => m.meterId)).toEqual(['session', 'weekly']);
    }

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const headers: unknown =
      init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
    if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
      expect(String(headers.get('Authorization'))).toBe('Bearer at');
      expect(String(headers.get('ChatGPT-Account-Id'))).toBe('acct');
    } else {
      const headerRecord = headers && typeof headers === 'object' && !Array.isArray(headers) ? (headers as Record<string, unknown>) : {};
      expect(headerRecord.Authorization).toBe('Bearer at');
      expect(headerRecord['ChatGPT-Account-Id']).toBe('acct');
    }
  });
});
