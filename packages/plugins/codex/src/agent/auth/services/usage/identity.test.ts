import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { resolveCodexUsageSubjectRef } from './identity.js';

describe('resolveCodexUsageSubjectRef', () => {
  it('uses provider-owned chatgpt account id evidence as the stable subject', () => {
    const now = 1_000;
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
        providerAccountId: 'chatgpt-account-1',
        providerEmail: 'same@example.com',
      },
    });

    expect(resolveCodexUsageSubjectRef({
      connectedServiceRecord: record,
      accountLabel: 'different@example.com',
    })).toEqual({
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: 'chatgpt-account-1',
      proof: 'connected_service_provider_account_id',
    });
  });

  it('does not merge by email when stable account id evidence is absent', () => {
    const first = resolveCodexUsageSubjectRef({
      accountLabel: 'same@example.com',
      provisionalDiscriminator: 'native-home-a',
    });
    const second = resolveCodexUsageSubjectRef({
      accountLabel: 'same@example.com',
      provisionalDiscriminator: 'native-home-b',
    });

    expect(first.kind).toBe('provisionalLocalSubject');
    expect(second.kind).toBe('provisionalLocalSubject');
    expect(first.accountSubjectId).not.toBe(second.accountSubjectId);
  });

  it('uses live app-server account id evidence instead of stale auth-store identity', () => {
    expect(resolveCodexUsageSubjectRef({
      liveProviderAccount: {
        providerAccountId: 'live-account',
        providerEmail: 'live@example.com',
      },
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'stale-auth-store-account',
      },
      provisionalDiscriminator: 'runtime-session-a',
    })).toEqual({
      providerId: 'openai-codex',
      kind: 'providerSubject',
      accountSubjectId: 'live-account',
      proof: 'live_app_server_account_id',
    });
  });

  it('keeps live account evidence with no account id provisional', () => {
    const subject = resolveCodexUsageSubjectRef({
      liveProviderAccount: {
        providerAccountId: null,
        providerEmail: 'label-only@example.com',
      },
      provisionalDiscriminator: 'runtime-session-a',
    });

    expect(subject).toMatchObject({
      kind: 'provisionalLocalSubject',
      reason: 'missing_stable_provider_account_id',
    });
  });

  it('requires provider-owned local evidence before creating a provisional subject', () => {
    expect(() => resolveCodexUsageSubjectRef({
      accountLabel: 'same@example.com',
    })).toThrow(/provisional subject discriminator/i);
  });

  it('keeps contradictory provider account id evidence provisional instead of picking one side', () => {
    const now = 1_000;
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
        providerAccountId: 'connected-account',
        providerEmail: 'user@example.com',
      },
    });

    const subject = resolveCodexUsageSubjectRef({
      connectedServiceRecord: record,
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'runtime-account',
      },
      provisionalDiscriminator: 'runtime-session-a',
    });

    expect(subject).toMatchObject({
      providerId: 'openai-codex',
      kind: 'provisionalLocalSubject',
      reason: 'conflicting_provider_account_ids',
    });
  });
});
