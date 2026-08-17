import { describe, expect, it } from 'vitest';

import { resolveCodexUsageSubjectRef } from './identity.js';
import { mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot } from './snapshot.js';

describe('mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot', () => {
  it('maps native app-server rate limits to a canonical provider account usage snapshot', () => {
    const subject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
      },
    });

    const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject,
      rawSnapshot: {
        rateLimits: {
          planType: 'team',
          account: { email: 'alice@example.com' },
          primary: { usedPercent: 25, resetsAt: 1_768_010_000 },
        },
      },
      observedAtMs: 1_768_000_000_000,
      fetchedAtMs: 1_768_000_000_000,
    });

    const parsed = snapshot;
    expect(parsed).toMatchObject({
      v: 1,
      providerId: 'openai-codex',
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      accountSubject: {
        kind: 'providerSubject',
        id: 'chatgpt-account-1',
      },
      planLabel: 'team',
      accountLabel: 'alice@example.com',
      meters: [expect.objectContaining({
        meterId: 'primary',
        utilizationPct: 25,
        resetsAt: 1_768_010_000_000,
      })],
    });
    expect(parsed).not.toHaveProperty('recordId');
  });

  it('uses stable chatgpt_account_id evidence instead of email labels for record identity', () => {
    const stableSubject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
      },
    });
    const nativeSnapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: stableSubject,
      rawSnapshot: { account: { email: 'native@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
    });
    const connectedSnapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: stableSubject,
      rawSnapshot: { account: { email: 'connected@example.com' }, primary: { usedPercent: 20 } },
      observedAtMs: 2_000,
      fetchedAtMs: 2_000,
    });

    expect(nativeSnapshot.recordKey).toEqual(connectedSnapshot.recordKey);

    const firstProvisional = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: resolveCodexUsageSubjectRef({
        accountLabel: 'same@example.com',
        provisionalDiscriminator: 'native-home-a',
      }),
      rawSnapshot: { account: { email: 'same@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
    });
    const secondProvisional = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: resolveCodexUsageSubjectRef({
        accountLabel: 'same@example.com',
        provisionalDiscriminator: 'native-home-b',
      }),
      rawSnapshot: { account: { email: 'same@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
    });

    expect(firstProvisional.recordKey).not.toEqual(secondProvisional.recordKey);
  });

  it('uses a trusted account-label fallback for native snapshots whose rate-limit payload has no email', () => {
    const subject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
        accountEmail: 'codex-user@example.test',
      },
    });

    const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject,
      rawSnapshot: { primary: { usedPercent: 10 } },
      accountLabel: 'codex-user@example.test',
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
    });

    expect(snapshot).toMatchObject({
      accountSubject: {
        kind: 'providerSubject',
        id: 'chatgpt-account-1',
      },
      accountLabel: 'codex-user@example.test',
    });
  });

  it('carries sanitized reset-credit inventory on provider account usage snapshots', () => {
    const subject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
      },
    });

    const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject,
      rawSnapshot: {
        rate_limit: {
          primary_window: { used_percent: 100 },
        },
        rate_limit_reset_credits: { available_count: 1 },
      },
      rawResetCredits: {
        available_count: 1,
        credits: [{
          id: 'credit-1',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-05-24T10:00:00.000Z',
          profile_image_url: 'https://example.com/private-avatar.png',
          profile_user_id: 'user-secret',
        }],
      },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
    });

    expect(snapshot.recoveryCredits).toEqual({
      availableCount: 1,
      credits: [expect.objectContaining({
        id: 'credit-1',
        status: 'available',
        expiresAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
      })],
    });
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('private-avatar');
    expect(JSON.stringify(snapshot.recoveryCredits)).not.toContain('user-secret');
  });
});
