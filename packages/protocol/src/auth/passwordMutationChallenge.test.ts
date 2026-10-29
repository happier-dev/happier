import { describe, expect, it } from 'vitest';
import {
  PasswordCredentialMutationV1Schema,
  PasswordMutationChallengeV1Schema,
  createPasswordCredentialMutationDigestV1,
  createPasswordMutationChallengeSigningInputV1,
} from './passwordMutationChallenge.js';
import { createKeyChallengeV2SigningInput } from './keyChallenge.js';

const mutation = {
  v: 1 as const,
  action: 'change' as const,
  accountId: 'account-1',
  expectedCredentialRevision: 1,
  normalizedNativeEmail: 'alice@example.test',
  newCredentialDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const challenge = {
  v: 1 as const,
  challengeId: 'challenge-1',
  nonce: 'nonce-1',
  issuedAt: '2026-09-05T12:00:00.000Z',
  expiresAt: '2026-09-05T12:05:00.000Z',
  audience: { origin: 'https://home.example.test', serverIdentityId: 'srv_home_1' },
  expectedAccountId: mutation.accountId,
  operationKind: 'password_credential_mutation_v1' as const,
  operationDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('password mutation challenge proof', () => {
  it('binds the complete normalized mutation, independently of object insertion order', () => {
    const digest = createPasswordCredentialMutationDigestV1(mutation);
    expect(createPasswordCredentialMutationDigestV1({
      newCredentialDigest: mutation.newCredentialDigest,
      normalizedNativeEmail: mutation.normalizedNativeEmail,
      expectedCredentialRevision: mutation.expectedCredentialRevision,
      accountId: mutation.accountId,
      action: mutation.action,
      v: mutation.v,
    })).toBe(digest);
    for (const change of [
      { action: 'recover' as const }, { accountId: 'account-2' },
      { expectedCredentialRevision: 2 }, { normalizedNativeEmail: 'bob@example.test' },
      { newCredentialDigest: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ]) expect(createPasswordCredentialMutationDigestV1({ ...mutation, ...change })).not.toBe(digest);
    expect(PasswordCredentialMutationV1Schema.safeParse({ ...mutation, bearer: 'token' }).success).toBe(false);
    expect(PasswordCredentialMutationV1Schema.safeParse({ ...mutation, normalizedNativeEmail: 'Alice@example.test' }).success).toBe(false);
  });

  it('uses a different signing domain and binds the exact challenge, Home, Account and mutation digest', () => {
    const bytes = createPasswordMutationChallengeSigningInputV1(challenge);
    const { v, operationKind, operationDigest, ...login } = challenge;
    expect(bytes).not.toEqual(createKeyChallengeV2SigningInput(login));
    for (const change of [
      { expectedAccountId: 'account-2' },
      { operationDigest: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { challengeId: 'challenge-2' }, { nonce: 'nonce-2' },
      { expiresAt: '2026-09-05T12:06:00.000Z' },
      { audience: { ...challenge.audience, serverIdentityId: 'srv_home_2' } },
    ]) expect(createPasswordMutationChallengeSigningInputV1({ ...challenge, ...change })).not.toEqual(bytes);
    expect(PasswordMutationChallengeV1Schema.safeParse({ ...challenge, operationKind: null }).success).toBe(false);
    expect(PasswordMutationChallengeV1Schema.safeParse({ ...challenge, audience: { origin: challenge.audience.origin } }).success).toBe(false);
    expect(PasswordMutationChallengeV1Schema.safeParse({ ...challenge, audience: { ...challenge.audience, extra: true } }).success).toBe(false);
  });
});
