import { describe, expect, it } from 'vitest';

import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';

describe('mapCodexRateLimitSnapshotToQuotaSnapshot', () => {
  it('maps Codex app-server rate-limit snapshots into connected-service quota meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
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

  it('uses live app-server account identity embedded in the rate-limit snapshot', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        account: {
          id: 'acct_live_codex',
          email: 'live@example.test',
        },
        primary: { used_percent: 12 },
      },
    });

    expect(snapshot).toMatchObject({
      activeAccountId: 'acct_live_codex',
      accountLabel: 'live@example.test',
    });
  });

  it('prefers exact connected-service account identity over raw app-server account fields', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      activeAccountId: 'acct_exact_connected_service',
      rawSnapshot: {
        account: {
          id: 'acct_provider_visible_stale',
          email: 'live@example.test',
        },
        primary: { used_percent: 12 },
      },
    });

    expect(snapshot).toMatchObject({
      activeAccountId: 'acct_exact_connected_service',
      accountLabel: 'live@example.test',
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

  it('preserves every app-server allowance identity from rateLimitsByLimitId', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rateLimits: { limitId: 'standard', primary: { usedPercent: 20 } },
        rateLimitsByLimitId: {
          standard: { limitId: 'standard', primary: { usedPercent: 20 } },
          spark: { limitId: 'spark', limitName: 'Spark', modelId: 'gpt-5-spark', primary: { usedPercent: 75 } },
        },
      },
    });

    expect(snapshot.meters).toEqual(expect.arrayContaining([
      expect.objectContaining({ meterId: 'standard:primary', providerLimitId: 'standard', utilizationPct: 20 }),
      expect.objectContaining({ meterId: 'spark:primary', providerLimitId: 'spark', modelId: 'gpt-5-spark', utilizationPct: 75 }),
    ]));
    expect(snapshot.meters.filter((meter) => meter.providerLimitId === 'standard')).toHaveLength(1);
  });

  it('preserves allowance metadata nested inside an additional rate_limit entry', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        additional_rate_limits: [{
          rate_limit: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            model_id: 'gpt-5.3-codex-spark',
            primary_window: { used_percent: 25 },
            secondary_window: { used_percent: 40 },
          },
        }],
      },
    });

    expect(snapshot.meters).toEqual([
      expect.objectContaining({
        meterId: 'codex_bengalfox:primary',
        providerLimitId: 'codex_bengalfox',
        label: 'GPT-5.3-Codex-Spark · Primary',
        modelId: 'gpt-5.3-codex-spark',
      }),
      expect.objectContaining({
        meterId: 'codex_bengalfox:secondary',
        providerLimitId: 'codex_bengalfox',
        label: 'GPT-5.3-Codex-Spark · Secondary',
        modelId: 'gpt-5.3-codex-spark',
      }),
    ]);
  });

  it('converts relative resets_in_seconds to absolute reset timestamps at mapping time (RD-QUO-1)', () => {
    const fetchedAt = 1_768_000_000_000;
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      rawSnapshot: {
        plan_type: 'pro',
        primary: {
          used_percent: 100,
          window_minutes: 300,
          resets_in_seconds: 1_800,
        },
        secondary: {
          used_percent: 40,
          window_minutes: 10080,
          resetsInSeconds: 86_400,
        },
      },
    });

    expect(snapshot.meters).toMatchObject([
      {
        meterId: 'primary',
        label: '5 hour',
        utilizationPct: 100,
        windowDurationMs: 300 * 60_000,
        resetAtMs: fetchedAt + 1_800_000,
        resetsAt: fetchedAt + 1_800_000,
      },
      {
        meterId: 'secondary',
        label: 'Weekly',
        utilizationPct: 40,
        resetAtMs: fetchedAt + 86_400_000,
        resetsAt: fetchedAt + 86_400_000,
      },
    ]);
  });

  it('prefers absolute reset fields over relative resets_in_seconds when both are present', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: {
          used_percent: 50,
          resets_at: '2026-05-17T16:00:00.000Z',
          resets_in_seconds: 60,
        },
      },
    });

    expect(snapshot.meters[0]).toMatchObject({
      resetsAt: Date.parse('2026-05-17T16:00:00.000Z'),
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

  it('maps ChatGPT wham usage reset-credit summary into generalized recovery credits', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        plan_type: 'pro',
        email: 'codex-user@example.test',
        rate_limit: {
          primary_window: {
            used_percent: 100,
            reset_at: '2026-06-17T12:00:00.000Z',
          },
          secondary_window: {
            used_percent: 40,
            reset_at: '2026-06-24T12:00:00.000Z',
          },
        },
        rate_limit_reset_credits: {
          available_count: 1,
        },
      },
    });

    expect(snapshot).toMatchObject({
      planLabel: 'pro',
      accountLabel: 'codex-user@example.test',
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        source: 'provider_api',
        confidence: 'derived',
        credits: [],
      },
      meters: [
        {
          meterId: 'primary',
          utilizationPct: 100,
          resetsAt: Date.parse('2026-06-17T12:00:00.000Z'),
        },
        {
          meterId: 'secondary',
          utilizationPct: 40,
          resetsAt: Date.parse('2026-06-24T12:00:00.000Z'),
        },
      ],
    });
  });

  it('maps Codex reset-credit collection details with expiry and redemption state', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: { used_percent: 100 },
      },
      rawResetCredits: {
        available_count: 1,
        credits: [
          {
            id: 'credit-1',
            reset_type: 'codex_rate_limits',
            status: 'available',
            granted_at: '2026-06-12T01:51:02.745763Z',
            expires_at: '2026-07-12T01:51:02.745763Z',
            redeem_started_at: null,
            redeemed_at: null,
            title: 'One free rate limit reset',
            description: 'Granted by the provider',
            profile_user_id: 'redacted-user-id',
            profile_image_url: 'https://example.test/profile.png',
          },
        ],
      },
    });

    expect(snapshot.recoveryCredits).toEqual({
      kind: 'usage_limit_resets',
      availableCount: 1,
      totalCount: 1,
      nextExpiresAtMs: Date.parse('2026-07-12T01:51:02.745Z'),
      source: 'provider_api',
      confidence: 'exact',
      credits: [
        {
          providerCreditId: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
          providerResetType: 'codex_rate_limits',
          title: 'One free rate limit reset',
          description: 'Granted by the provider',
          grantedAtMs: Date.parse('2026-06-12T01:51:02.745Z'),
          expiresAtMs: Date.parse('2026-07-12T01:51:02.745Z'),
          redeemStartedAtMs: null,
          redeemedAtMs: null,
        },
      ],
    });
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('profile_user_id');
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('profile_image_url');
  });
});
