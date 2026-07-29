import { describe, expect, it } from 'vitest';

import { persistedSessionAccountIdentityMatchesFailingAccount } from './resolvePersistedMaterializationIdentityFanoutMatch';
import type { PersistedSessionAccountIdentity, RuntimeAccountIdentityEntry } from './runtimeAccountIdentityTypes';

function identity(overrides: Partial<PersistedSessionAccountIdentity> = {}): PersistedSessionAccountIdentity {
  return {
    providerAccountId: 'acct-a',
    serviceId: 'openai-codex',
    groupId: 'team',
    profileId: 'primary',
    groupGeneration: 4,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<Pick<RuntimeAccountIdentityEntry, 'serviceId' | 'groupId' | 'groupGeneration'>> = {},
): Pick<RuntimeAccountIdentityEntry, 'serviceId' | 'groupId' | 'groupGeneration'> {
  return {
    serviceId: 'openai-codex',
    groupId: 'team',
    groupGeneration: 4,
    ...overrides,
  };
}

describe('persistedSessionAccountIdentityMatchesFailingAccount', () => {
  it('matches when the persisted provider account and group binding equal the failing account', () => {
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity(),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate(),
    })).toBe(true);
  });

  it('vetoes a persisted identity for a different provider account (durable mismatch is authoritative)', () => {
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity({ providerAccountId: 'acct-b' }),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate(),
    })).toBe(false);
  });

  it('rejects when the failing account or persisted account id is empty', () => {
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity({ providerAccountId: '   ' }),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate(),
    })).toBe(false);
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity(),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: '',
      candidate: candidate(),
    })).toBe(false);
  });

  it('rejects a mismatched service or group binding', () => {
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity({ groupId: 'other' }),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate(),
    })).toBe(false);
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity(),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate({ groupId: 'other' }),
    })).toBe(false);
  });

  it('treats an unknown (null) generation on either side as consistent, but rejects a contradiction', () => {
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity({ groupGeneration: null }),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate({ groupGeneration: 4 }),
    })).toBe(true);
    expect(persistedSessionAccountIdentityMatchesFailingAccount({
      identity: identity({ groupGeneration: 7 }),
      serviceId: 'openai-codex',
      groupId: 'team',
      providerAccountId: 'acct-a',
      candidate: candidate({ groupGeneration: 4 }),
    })).toBe(false);
  });
});
