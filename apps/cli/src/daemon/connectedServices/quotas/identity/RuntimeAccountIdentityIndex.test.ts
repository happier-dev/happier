import { describe, expect, it } from 'vitest';

import { RuntimeAccountIdentityIndex } from './RuntimeAccountIdentityIndex';
import { resolveSessionsSharingProviderAccount } from './resolveSessionsSharingProviderAccount';

describe('RuntimeAccountIdentityIndex', () => {
  it('resolves only fresh sessions proven on the same live provider account', () => {
    let now = 10_000;
    const index = new RuntimeAccountIdentityIndex({
      nowMs: () => now,
      ttlMs: 5_000,
    });

    index.record({
      sessionId: 'source',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: 'a@example.com',
      observedAtMs: now,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    index.record({
      sessionId: 'same-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-a',
      accountLabel: 'a@example.com',
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });
    index.record({
      sessionId: 'different-account',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'primary',
      providerAccountId: 'acct-b',
      accountLabel: 'b@example.com',
      observedAtMs: now,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 4,
    });

    expect(resolveSessionsSharingProviderAccount(index, {
      serviceId: 'openai-codex',
      providerAccountId: 'acct-a',
      excludeSessionId: 'source',
      currentGroupGenerationBySessionId: new Map([
        ['same-account', 4],
        ['different-account', 4],
      ]),
    }).map((entry) => entry.sessionId)).toEqual(['same-account']);

    now = 20_001;
    expect(resolveSessionsSharingProviderAccount(index, {
      serviceId: 'openai-codex',
      providerAccountId: 'acct-a',
    })).toEqual([]);
  });

  it('refuses weak auth-surface proof and invalidates by session', () => {
    const index = new RuntimeAccountIdentityIndex({
      nowMs: () => 1_000,
      ttlMs: 60_000,
    });

    expect(index.record({
      sessionId: 'claude-session',
      serviceId: 'claude-subscription',
      groupId: 'claude-team',
      profileId: 'primary',
      providerAccountId: 'acct-claude',
      accountLabel: null,
      observedAtMs: 1_000,
      source: 'active_account_verification',
      proofStrength: 'weak',
      groupGeneration: 7,
    })).toEqual({ status: 'suppressed', reason: 'exact_provider_account_proof_required' });

    expect(index.record({
      sessionId: 'codex-session',
      serviceId: 'openai-codex',
      groupId: 'codex-team',
      profileId: 'primary',
      providerAccountId: 'acct-codex',
      accountLabel: null,
      observedAtMs: 1_000,
      source: 'active_account_verification',
      proofStrength: 'exact',
      groupGeneration: 8,
    })).toEqual({ status: 'recorded' });
    expect(index.readSessionIdentity('codex-session')).toMatchObject({
      providerAccountId: 'acct-codex',
    });

    index.invalidateSession('codex-session');
    expect(index.readSessionIdentity('codex-session')).toBeNull();
  });

  it('refuses group-bound exact account identity without group generation proof', () => {
    const index = new RuntimeAccountIdentityIndex({
      nowMs: () => 1_000,
      ttlMs: 60_000,
    });

    expect(index.record({
      sessionId: 'codex-session',
      serviceId: 'openai-codex',
      groupId: 'codex-team',
      profileId: 'primary',
      providerAccountId: 'acct-codex',
      accountLabel: null,
      observedAtMs: 1_000,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: null,
    })).toEqual({ status: 'suppressed', reason: 'missing_group_generation' });
    expect(index.readSessionIdentity('codex-session')).toBeNull();
  });
});
