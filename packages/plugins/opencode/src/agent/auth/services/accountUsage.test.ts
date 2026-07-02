import { describe, expect, it } from 'vitest';

import { mapOpenCodeUsageLimitToAccountUsageObservation } from './accountUsage.js';

describe('mapOpenCodeUsageLimitToAccountUsageObservation', () => {
  it('maps reliable OpenCode runtime usage-limit evidence to a provisional account observation', () => {
    expect(mapOpenCodeUsageLimitToAccountUsageObservation({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: 60_000,
      resetAtMs: 1_768_010_000_000,
      quotaScope: 'account',
      providerLimitId: 'free_tier_limit',
      action: null,
    }, {
      provisionalSubjectDiscriminator: 'runtime:session-a',
    })).toEqual({
      providerId: 'opencode',
      source: 'runtimeSignal',
      confidence: 'subject_provisional',
      accountSubject: {
        kind: 'provisionalLocalSubject',
        id: 'opencode:account:provisional:a94486a368fcee2cdf177989',
      },
      quotaScope: 'account',
      status: 'limited',
      diagnostic: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        providerLimitId: 'free_tier_limit',
        retryAfterMs: 60_000,
        resetAtMs: 1_768_010_000_000,
        action: null,
      },
    });
  });

  it('does not merge unrelated provisional observations that share a provider limit id', () => {
    const classification = {
      kind: 'usage_limit' as const,
      limitCategory: 'usage_limit' as const,
      retryAfterMs: 60_000,
      resetAtMs: 1_768_010_000_000,
      quotaScope: 'account' as const,
      providerLimitId: 'free_tier_limit',
      action: null,
    };

    const first = mapOpenCodeUsageLimitToAccountUsageObservation(classification, {
      provisionalSubjectDiscriminator: 'runtime:session-a',
    });
    const second = mapOpenCodeUsageLimitToAccountUsageObservation(classification, {
      provisionalSubjectDiscriminator: 'runtime:session-b',
    });

    expect(first?.accountSubject.id).not.toBe(second?.accountSubject.id);
  });

  it('does not invent a provider-global account usage record when no usage evidence exists', () => {
    expect(mapOpenCodeUsageLimitToAccountUsageObservation(null, {
      provisionalSubjectDiscriminator: 'runtime:session-a',
    })).toBeNull();
  });
});
