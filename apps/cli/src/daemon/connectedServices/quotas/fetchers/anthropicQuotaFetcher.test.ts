import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createAnthropicQuotaFetcher } from './anthropicQuotaFetcher';

describe('createAnthropicQuotaFetcher', () => {
  it('fetches and parses Anthropic oauth usage into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
        seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 20, utilization: 20 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
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
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createAnthropicQuotaFetcher({ staleAfterMs: 300_000 });
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('five_hour');
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('seven_day');
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('extra_usage');
    }

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const headers: unknown =
      init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
    if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
      expect(String(headers.get('Authorization'))).toBe('Bearer at');
      expect(String(headers.get('anthropic-beta'))).toBe('oauth-2025-04-20');
    } else {
      const headerRecord = headers && typeof headers === 'object' && !Array.isArray(headers) ? (headers as Record<string, unknown>) : {};
      expect(headerRecord.Authorization).toBe('Bearer at');
      expect(headerRecord['anthropic-beta']).toBe('oauth-2025-04-20');
    }
  });
});
