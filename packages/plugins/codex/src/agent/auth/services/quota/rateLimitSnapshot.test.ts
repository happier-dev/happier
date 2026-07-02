import { describe, expect, it } from 'vitest';

import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './rateLimitSnapshot.js';

describe('mapCodexRateLimitSnapshotToQuotaSnapshot', () => {
  it('maps Codex app-server rate-limit snapshots into connected-service quota meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      activeAccountId: 'acct_123',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        plan_type: 'plus',
        account: { email: 'alice@example.com' },
        primary: {
          used_percent: 87.5,
          resets_at: '2026-05-17T16:00:00.000Z',
        },
        secondary: {
          used_percent: 42,
          resets_at: 1_768_010_000_000,
        },
      },
    });

    expect(snapshot).toMatchObject({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      activeAccountId: 'acct_123',
      fetchedAt: 1_768_000_000_000,
      planLabel: 'plus',
      accountLabel: 'alice@example.com',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          utilizationPct: 87.5,
          resetsAt: Date.parse('2026-05-17T16:00:00.000Z'),
        },
        {
          meterId: 'secondary',
          label: 'Secondary',
          utilizationPct: 42,
          resetsAt: 1_768_010_000_000,
        },
      ],
    });
  });

  it('unwraps official app-server rateLimits response and notification envelopes', () => {
    for (const rawSnapshot of [
      {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_768_010_000 },
        },
        rateLimitsByLimitId: null,
      },
      {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_768_010_000 },
        },
      },
    ]) {
      const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_768_000_000_000,
        rawSnapshot,
      });

      expect(snapshot).toMatchObject({
        planLabel: 'pro',
        meters: [{
          meterId: 'primary',
          utilizationPct: 100,
          resetsAt: 1_768_010_000_000,
        }],
      });
    }
  });

  it('uses a trusted account-label fallback when the rate-limit payload has no email label', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'native-profile',
      activeAccountId: 'acct_123',
      accountLabel: 'codex-user@example.test',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: { usedPercent: 44 },
      },
    });

    expect(snapshot).toMatchObject({
      activeAccountId: 'acct_123',
      accountLabel: 'codex-user@example.test',
    });
  });

  it('maps app-server primary and secondary window snapshots as separate meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rate_limits: {
          plan_type: 'team',
          primary_window: {
            used_percent: 99,
            resets_at: '2026-05-17T18:00:00.000Z',
          },
          secondary_window: {
            used_percent: 15,
            resets_at: '2026-05-18T18:00:00.000Z',
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      planLabel: 'team',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          remainingPct: 1,
          resetAtMs: Date.parse('2026-05-17T18:00:00.000Z'),
          providerLimitId: 'primary',
          scope: 'primary',
          utilizationPct: 99,
          resetsAt: Date.parse('2026-05-17T18:00:00.000Z'),
        },
        {
          meterId: 'secondary',
          label: 'Secondary',
          remainingPct: 85,
          resetAtMs: Date.parse('2026-05-18T18:00:00.000Z'),
          providerLimitId: 'secondary',
          scope: 'secondary',
          utilizationPct: 15,
          resetsAt: Date.parse('2026-05-18T18:00:00.000Z'),
        },
      ],
    });
  });

  it('preserves numeric usage and limit fields from Codex meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: {
          usedTokens: '128',
          tokenLimit: 256,
        },
      },
    });

    expect(snapshot.meters).toEqual([
      expect.objectContaining({
        meterId: 'primary',
        used: 128,
        limit: 256,
        status: 'ok',
      }),
    ]);
  });

  it('ignores blank numeric fields instead of treating them as zero values', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: {
          usedPercent: ' ',
          usedTokens: '',
          tokenLimit: '   ',
        },
      },
    });

    expect(snapshot.meters).toEqual([]);
  });
});
