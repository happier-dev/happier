import { describe, expect, it } from 'vitest';

import type { CodexUsageSubjectRef } from '../usage/identity.js';
import { mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot } from '../usage/snapshot.js';
import {
  readCodexRateLimitReadiness,
  mapCodexRateLimitSnapshotToUsageMeters,
  readCodexRateLimitSnapshotPlanLabel,
} from './rateLimitSnapshot.js';

function mapCodexRateLimitSnapshotToUsageSnapshot(params: Readonly<{
  profileId: string;
  activeAccountId?: string | null;
  accountLabel?: string | null;
  fetchedAt: number;
  staleAfterMs?: number;
  rawSnapshot: unknown;
  rawResetCredits?: unknown;
}>) {
  const subject: CodexUsageSubjectRef = params.activeAccountId
    ? {
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: params.activeAccountId,
      proof: 'connected_service_provider_account_id',
    }
    : {
      providerId: 'openai-codex',
      kind: 'provisionalLocalSubject',
      accountSubjectId: `provisional:test:${params.profileId}`,
      reason: 'missing_stable_provider_account_id',
    };
  return mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
    subject,
    accountLabel: params.accountLabel,
    observedAtMs: params.fetchedAt,
    fetchedAtMs: params.fetchedAt,
    staleAfterMs: params.staleAfterMs,
    rawSnapshot: params.rawSnapshot,
    rawResetCredits: params.rawResetCredits,
  });
}

describe('Codex public runtime usage snapshots', () => {
  it.each([null, false, ' '] as const)('keeps an unreported allowance unknown instead of inventing zero usage (%j)', missing => {
    const resetAt = 1_800_000_000;
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({ profileId: 'work', fetchedAt: 1_768_000_000_000,
      rawSnapshot: { primary: { used_percent: 0, resets_at: resetAt }, secondary: {
        utilization_pct: missing, used_tokens: missing, token_limit: 100, resets_at: resetAt,
      } } });
    expect(snapshot.meters.find(meter => meter.meterId === 'secondary')).toMatchObject({
      utilizationPct: null, used: null, limit: 100, remainingPct: null, confidence: 'unknown', resetsAt: resetAt * 1000,
    });
    expect(snapshot.meters.find(meter => meter.meterId === 'primary')).toMatchObject({
      utilizationPct: 0, remainingPct: 100, confidence: 'exact',
    });
  });

  it.each([
    // Codex rust-v0.162.1 protocol/src/auth.rs KnownPlan::display_name and raw aliases.
    ['promax', 'ChatGPT Pro (Max)'], ['prolite', 'ChatGPT Pro'], ['pro', 'ChatGPT Pro (More)'],
    ['free', 'ChatGPT Free'], ['go', 'ChatGPT Go'], ['plus', 'ChatGPT Plus'], ['team', 'ChatGPT Team'],
    ['self_serve_business_prolite', 'ChatGPT Self Serve Business ProLite'],
    ['self_serve_business_usage_based', 'ChatGPT Self Serve Business Usage Based'],
    ['business', 'ChatGPT Business'], ['ent26', 'ChatGPT Enterprise'],
    ['enterprise_cbp_automation', 'ChatGPT Enterprise (Automation)'],
    ['enterprise_cbp_usage_based', 'ChatGPT Enterprise CBP Usage Based'],
    ['enterprise', 'ChatGPT Enterprise'], ['hc', 'ChatGPT Enterprise'],
    ['edu', 'ChatGPT Edu'], ['education', 'ChatGPT Edu'], ['edu_plus', 'ChatGPT Edu Plus'], ['edu_pro', 'ChatGPT Edu Pro'],
    ['A future plan', 'A future plan'], ['future_sku', 'future_sku'],
  ])('publishes display-ready plan %s through both snapshot envelopes', (id, label) => {
    expect(readCodexRateLimitSnapshotPlanLabel({ plan_type: id })).toBe(label);
    expect(readCodexRateLimitSnapshotPlanLabel({ rateLimits: { planType: id } })).toBe(label);
  });

  it('maps Codex app-server rate-limit snapshots into connected-service quota meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
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
      providerId: 'openai-codex',
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      fetchedAtMs: 1_768_000_000_000,
      planLabel: 'ChatGPT Plus',
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

  it('normalizes app-server reset timestamps through the shared epoch boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [resetsAt, expected] of cases) {
      const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
        profileId: 'work',
        fetchedAt: 1_768_000_000_000,
        rawSnapshot: {
          primary: { used_percent: 50, resets_at: resetsAt },
        },
      });

      expect(snapshot.meters).toEqual([expect.objectContaining({
        meterId: 'primary',
        resetsAt: expected,
      })]);
    }
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
      const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
        profileId: 'work',
        fetchedAt: 1_768_000_000_000,
        rawSnapshot,
      });

      expect(snapshot).toMatchObject({
        planLabel: 'ChatGPT Pro (More)',
        meters: [{
          meterId: 'primary',
          utilizationPct: 100,
          resetsAt: 1_768_010_000_000,
        }],
      });
    }
  });

  it('preserves app-server named provider limits as distinct selectable allowance families', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 20, resetsAt: 1_768_010_000 },
        },
        rateLimitsByLimitId: {
          codex_spark: {
            limitName: 'Spark',
            modelId: 'gpt-5.3-codex-spark',
            primary: { usedPercent: 91, resetsAt: 1_768_020_000 },
            secondary: { usedPercent: 45, resetsAt: 1_768_030_000 },
          },
        },
      },
    });

    expect(snapshot.meters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        meterId: 'codex_spark:primary',
        label: 'Spark · Primary',
        providerLimitId: 'codex_spark',
        modelId: 'gpt-5.3-codex-spark',
        utilizationPct: 91,
      }),
      expect.objectContaining({
        meterId: 'codex_spark:secondary',
        label: 'Spark · Secondary',
        providerLimitId: 'codex_spark',
        modelId: 'gpt-5.3-codex-spark',
        utilizationPct: 45,
      }),
    ]));
    expect(snapshot.meters.some((meter) => meter.meterId === 'primary')).toBe(false);
  });

  it('uses the provider metered feature for an array-shaped additional allowance', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rateLimits: {
          primary: { usedPercent: 35, resetsAt: 1_768_010_000 },
        },
        additional_rate_limits: [{
          limit_name: 'Spark',
          metered_feature: 'codex_spark',
          rate_limit: {
            model_id: 'gpt-5.3-codex-spark',
            primary: { used_percent: 91, resets_at: 1_768_020_000 },
          },
        }],
      },
    });

    expect(snapshot.meters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        meterId: 'codex_spark:primary',
        label: 'Spark · Primary',
        providerLimitId: 'codex_spark',
        modelId: 'gpt-5.3-codex-spark',
        utilizationPct: 91,
      }),
    ]));
  });

  it('normalizes merged sparse app-server snapshots without erasing identity or reset windows', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
      profileId: 'work',
      activeAccountId: 'acct_live_codex',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rateLimits: {
          account: {
            id: 'acct_live_codex',
            email: 'codex-user@example.test',
          },
          primary: {
            usedPercent: 88,
            windowDurationMins: 300,
            resetsAt: 1_779_098_400,
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 10080,
            resetsAt: 1_779_698_400,
          },
          planType: 'pro',
        },
      },
    });

    expect(snapshot).toMatchObject({
      providerId: 'openai-codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_live_codex' },
      accountLabel: 'codex-user@example.test',
      planLabel: 'ChatGPT Pro (More)',
      meters: [
        {
          meterId: 'primary',
          utilizationPct: 88,
          label: '5-hour',
          windowDurationMs: 300 * 60_000,
          resetAtMs: 1_779_098_400_000,
          resetsAt: 1_779_098_400_000,
        },
        {
          meterId: 'secondary',
          utilizationPct: 40,
          label: 'Weekly',
          windowDurationMs: 10_080 * 60_000,
          resetAtMs: 1_779_698_400_000,
          resetsAt: 1_779_698_400_000,
        },
      ],
    });
  });

  it('uses a trusted account-label fallback when the rate-limit payload has no email label', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
      profileId: 'native-profile',
      activeAccountId: 'acct_123',
      accountLabel: 'codex-user@example.test',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: { usedPercent: 44 },
      },
    });

    expect(snapshot).toMatchObject({
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      accountLabel: 'codex-user@example.test',
    });
  });

  it('maps app-server primary and secondary window snapshots as separate meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
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
      planLabel: 'ChatGPT Team',
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

  it('maps Codex reset-credit payloads into sanitized recovery credits', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rate_limit: {
          primary_window: { used_percent: 100 },
        },
        rate_limit_reset_credits: {
          available_count: 1,
        },
      },
      rawResetCredits: {
        available_count: 1,
        credits: [{
          id: 'credit-1',
          reset_type: 'codex_rate_limits',
          status: 'available',
          granted_at: '2026-05-17T10:00:00.000Z',
          expires_at: '2026-05-24T10:00:00.000Z',
          profile_image_url: 'https://example.com/private-avatar.png',
          profile_user_id: 'user-secret',
          title: 'Codex rate limit reset',
          description: 'Reset your Codex rate limits.',
        }],
      },
    });

    expect(snapshot.recoveryCredits).toEqual({
      availableCount: 1,
      credits: [{
        id: 'credit-1',
        kind: 'usage_limit_reset',
        status: 'available',
        grantedAtMs: Date.parse('2026-05-17T10:00:00.000Z'),
        expiresAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
        title: 'Codex rate limit reset',
        description: 'Reset your Codex rate limits.',
      }],
    });
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('private-avatar');
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('user-secret');
  });

  it('preserves numeric usage and limit fields from Codex meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
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
    const snapshot = mapCodexRateLimitSnapshotToUsageSnapshot({
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

describe('Codex provider credits', () => {
  const spentWindow = { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_768_600_000 };
  const creditMeter = (meters: ReturnType<typeof mapCodexRateLimitSnapshotToUsageMeters>) =>
    meters.find((meter) => meter.unit === 'credits') ?? null;

  it('maps the wham/usage credit balance into a credit meter beside the spent allowance', () => {
    const payload = {
      rate_limit: { allowed: true, limit_reached: false, primary_window: spentWindow },
      credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '16845' },
    };
    expect(creditMeter(mapCodexRateLimitSnapshotToUsageMeters(payload))).toMatchObject({
      meterId: 'credits', unit: 'credits', remaining: 16_845, isExhausted: false, status: 'ok',
    });
  });

  it('maps app-server camelCase credits and unlimited credits', () => {
    expect(creditMeter(mapCodexRateLimitSnapshotToUsageMeters({
      rateLimits: { primary: { usedPercent: 100 }, credits: { hasCredits: true, unlimited: true, balance: null } },
    }))).toMatchObject({ remaining: null, isExhausted: false });
  });

  it('marks credits spent when the balance, overage limit, or spend control says so', () => {
    for (const payload of [
      { credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '0' } },
      { credits: { has_credits: true, unlimited: false, overage_limit_reached: true, balance: '120' } },
      { credits: { has_credits: true, unlimited: false, balance: '120' }, spend_control: { reached: true } },
    ]) {
      expect(creditMeter(mapCodexRateLimitSnapshotToUsageMeters(payload))).toMatchObject({ isExhausted: true });
    }
  });

  it('adds no credit meter for accounts without credits and keeps recovery readiness on included windows', () => {
    expect(creditMeter(mapCodexRateLimitSnapshotToUsageMeters({
      rate_limit: { primary_window: spentWindow },
      credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
    }))).toBeNull();
    expect(readCodexRateLimitReadiness({
      rate_limit: { primary_window: { used_percent: 20 } },
      credits: { has_credits: true, unlimited: false, overage_limit_reached: true, balance: '0' },
    })).toEqual({ status: 'ready' });
  });

  // observed: upstream app-server-protocol/src/protocol/v2/account.rs:370-373 (`ordinaryUsageAllowed`:
  // "clients must not infer recovery from percentages or reset times") and wham/usage `rate_limit.allowed`
  // (codex-backend-openapi-models rate_limit_status_details.rs:17-18).
  it('takes the backend usage permission over window percentages', () => {
    expect(readCodexRateLimitReadiness({
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 20 } },
    })).toEqual({ status: 'waiting', resetAtMs: null });
    expect(readCodexRateLimitReadiness({
      ordinaryUsageAllowed: true,
      rateLimits: { primary: spentWindow },
    })).toEqual({ status: 'ready' });
    expect(readCodexRateLimitReadiness({
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 20 } },
    })).toEqual({ status: 'waiting', resetAtMs: null });
  });
});
