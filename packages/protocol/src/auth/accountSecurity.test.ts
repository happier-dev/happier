import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  AccountSecurityServerErrorV1Schema,
  AccountSecurityRouteErrorV1Schema,
  AccountPasswordEnrollRequestV1Schema,
  AccountPasswordChangeRequestV1Schema,
  PasswordMutationPreparationRequestV1Schema,
} from './accountSecurity.js';
import { buildE2eeAccountPasswordChangeRequestV1, buildE2eeAccountPasswordEnrollRequestV1 } from './accountSecurityCrypto.js';
import {
  createPasswordCredentialMutationDigestV1,
  createPasswordCredentialTargetDigestV1,
  createPasswordMutationChallengeSigningInputV1,
} from './passwordMutationChallenge.js';
import { decodePasswordCredentialFieldV1, encodePasswordCredentialFieldV1 } from './accountPasswordCredential.js';

describe('Account Security request schemas', () => {
  it('binds Plain enrollment to one prepared credential without a caller-selected digest', () => {
    const field = (bytes: number) => encodePasswordCredentialFieldV1(new Uint8Array(bytes));
    const targetCredential = {
      v: 1 as const,
      kind: 'plain_password_hash' as const,
      hash: {
        v: 1 as const,
        algorithm: 'scrypt' as const,
        parameters: { n: 2 ** 14, r: 8 as const, p: 5, keyLength: 32 as const },
        salt: field(16),
        digest: field(32),
      },
    };
    const input = {
      v: 1 as const,
      kind: 'plain' as const,
      email: 'person@example.test',
      targetCredential,
      reauthentication: { provider: 'mtls', pending: 'pending-proof', proof: 'proof' },
    };

    expect(AccountPasswordEnrollRequestV1Schema.safeParse(input).success).toBe(true);
    expect(AccountPasswordEnrollRequestV1Schema.safeParse({
      ...input,
      password: 'must not cross the final enrollment boundary',
    }).success).toBe(false);
    expect(AccountPasswordEnrollRequestV1Schema.safeParse({
      ...input,
      requestDigest: 'A'.repeat(43),
    }).success).toBe(false);
    expect(AccountPasswordEnrollRequestV1Schema.safeParse({
      ...input,
      targetCredential: { ...targetCredential, kind: 'e2ee_password_envelope' },
    }).success).toBe(false);
  });

  it('keeps password mutations recursively closed', () => {
    const valid = {
      v: 1,
      kind: 'plain',
      expectedCredentialRevision: 1,
      currentPassword: 'current password value',
      newPassword: 'replacement password value',
    } as const;
    expect(AccountPasswordChangeRequestV1Schema.safeParse(valid).success).toBe(true);
    expect(AccountPasswordChangeRequestV1Schema.safeParse({ ...valid, accountId: 'caller-selected' }).success).toBe(false);
    expect(AccountPasswordChangeRequestV1Schema.safeParse({
      ...valid,
      newPassword: '\u{1f600}'.repeat(400),
    }).success).toBe(false);

    const field = (bytes: number) => encodePasswordCredentialFieldV1(new Uint8Array(bytes));
    const e2ee = {
      v: 1,
      kind: 'e2ee',
      action: 'recover',
      expectedCredentialRevision: 1,
      targetCredential: {
        v: 1,
        kind: 'e2ee_password_envelope',
        envelope: {
          v: 1,
      accountSigningPublicKey: encodePasswordCredentialFieldV1(
        tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32)).publicKey,
      ),
          kdf: { algorithm: 'argon2id13', salt: field(16), opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
          cipher: { algorithm: 'aes256gcm', nonce: field(12), ciphertext: field(48) },
        },
        authVerifier: {
          v: 1,
          hash: { v: 1, algorithm: 'scrypt', parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 }, salt: field(16), digest: field(32) },
        },
      },
      proof: { challengeId: 'challenge', publicKey: field(32), signature: field(64) },
    } as const;
    // Recovery is an explicit operation binding. Omitting or substituting the
    // action may never let a `recover` challenge redeem as an ordinary change.
    expect(AccountPasswordChangeRequestV1Schema.safeParse(e2ee).success).toBe(true);
    expect(AccountPasswordChangeRequestV1Schema.safeParse({ ...e2ee, action: undefined }).success).toBe(false);
    expect(AccountPasswordChangeRequestV1Schema.safeParse({ ...e2ee, action: 'remove' }).success).toBe(false);
  });

  it('rejects ambiguous and extended mutation preparation before password work', () => {
    const base = {
      v: 1,
      action: 'change',
      expectedCredentialRevision: 1,
      normalizedNativeEmail: 'alice@example.test',
      newPlainPassword: 'replacement password value',
    } as const;
    expect(PasswordMutationPreparationRequestV1Schema.safeParse(base).success).toBe(true);
    expect(PasswordMutationPreparationRequestV1Schema.safeParse({
      ...base,
      newE2eePassword: { envelope: {}, authKey: 'A'.repeat(43) },
    }).success).toBe(false);
    expect(PasswordMutationPreparationRequestV1Schema.safeParse({ ...base, mode: 'e2ee' }).success).toBe(false);
  });

  it('keeps domain recovery errors strict and typed for Action transports', () => {
    expect(AccountSecurityServerErrorV1Schema.parse({ error: 'conflict' })).toEqual({ error: 'conflict' });
    expect(AccountSecurityServerErrorV1Schema.safeParse({ error: 'email_delivery_unavailable' }).success).toBe(true);
    expect(AccountSecurityServerErrorV1Schema.safeParse({ error: 'password_hash_overloaded' }).success).toBe(true);
    expect(AccountSecurityServerErrorV1Schema.safeParse({ error: 'account-disabled' }).success).toBe(true);
    expect(AccountSecurityServerErrorV1Schema.safeParse({ error: 'account_disabled' }).success).toBe(false);
    expect(AccountSecurityServerErrorV1Schema.safeParse({ error: 'conflict', detail: 'secret' }).success).toBe(false);
    expect(AccountSecurityRouteErrorV1Schema.parse({ error: 'invalid_token' })).toEqual({ error: 'invalid_token' });
    expect(AccountSecurityRouteErrorV1Schema.parse({ error: 'method_not_available' })).toEqual({ error: 'method_not_available' });
    expect(AccountSecurityRouteErrorV1Schema.parse({ error: 'provider-required', provider: 'github' })).toEqual({
      error: 'provider-required',
      provider: 'github',
    });
    expect(AccountSecurityRouteErrorV1Schema.safeParse({
      error: 'provider-required',
      provider: 'github',
      detail: 'secret',
    }).success).toBe(false);
  });

  it('assembles one canonical E2EE mutation proof and rejects a substituted envelope', () => {
    const field = (bytes: number, fill = 0) => encodePasswordCredentialFieldV1(new Uint8Array(bytes).fill(fill));
    const recoverySecret = new Uint8Array(32);
    const envelope = {
      v: 1 as const,
      accountSigningPublicKey: encodePasswordCredentialFieldV1(
        tweetnacl.sign.keyPair.fromSeed(recoverySecret).publicKey,
      ),
      kdf: { algorithm: 'argon2id13' as const, salt: field(16), opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
      cipher: { algorithm: 'aes256gcm' as const, nonce: field(12), ciphertext: field(48) },
    };
    const targetCredential = {
      v: 1 as const,
      kind: 'e2ee_password_envelope' as const,
      envelope,
      authVerifier: {
        v: 1 as const,
        hash: { v: 1 as const, algorithm: 'scrypt' as const, parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 }, salt: field(16), digest: field(32) },
      },
    };
    const mutation = {
      v: 1 as const, action: 'recover' as const, accountId: 'account-1',
      expectedCredentialRevision: 4, normalizedNativeEmail: 'person@example.test',
      newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
    };
    const challenge = {
      v: 1 as const, challengeId: 'challenge-1', nonce: 'nonce',
      issuedAt: '2026-09-08T10:00:00.000Z', expiresAt: '2026-09-08T10:05:00.000Z',
      audience: { origin: 'https://home.example.test', serverIdentityId: 'srv_home' },
      expectedAccountId: 'account-1', operationKind: 'password_credential_mutation_v1' as const,
      operationDigest: createPasswordCredentialMutationDigestV1(mutation),
    };
    const built = buildE2eeAccountPasswordChangeRequestV1({
      action: 'recover', expectedCredentialRevision: 4,
      accountId: 'account-1', normalizedNativeEmail: 'person@example.test',
      recoverySecret, expectedEnvelope: envelope,
      expectedAudience: challenge.audience,
      preparation: { targetCredential, challenge },
    });
    expect(built).toMatchObject({ v: 1, kind: 'e2ee', action: 'recover', expectedCredentialRevision: 4, targetCredential });
    expect(built.proof.publicKey).toBe(envelope.accountSigningPublicKey);
    expect(tweetnacl.sign.detached.verify(
      createPasswordMutationChallengeSigningInputV1(challenge),
      decodePasswordCredentialFieldV1(built.proof.signature),
      decodePasswordCredentialFieldV1(built.proof.publicKey),
    )).toBe(true);

    const enrollmentMutation = {
      v: 1 as const, action: 'connect' as const, accountId: 'account-1',
      expectedCredentialRevision: null, normalizedNativeEmail: 'person@example.test',
      newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
    };
    const enrollment = buildE2eeAccountPasswordEnrollRequestV1({
      email: 'person@example.test',
      verificationToken: 'A'.repeat(43),
      accountId: 'account-1',
      normalizedNativeEmail: 'person@example.test',
      recoverySecret,
      expectedEnvelope: envelope,
      expectedAudience: challenge.audience,
      preparation: {
        targetCredential,
        challenge: {
          ...challenge,
          operationDigest: createPasswordCredentialMutationDigestV1(enrollmentMutation),
        },
      },
    });
    expect(enrollment).toMatchObject({
      v: 1,
      kind: 'e2ee',
      email: 'person@example.test',
      verificationToken: 'A'.repeat(43),
      targetCredential,
    });

    expect(() => buildE2eeAccountPasswordChangeRequestV1({
      action: 'recover', expectedCredentialRevision: 4,
      accountId: 'account-1', normalizedNativeEmail: 'person@example.test',
      recoverySecret, expectedEnvelope: envelope,
      expectedAudience: challenge.audience,
      preparation: {
        targetCredential: {
          ...targetCredential,
          envelope: { ...envelope, cipher: { ...envelope.cipher, ciphertext: field(48, 9) } },
        },
        challenge,
      },
    })).toThrow('password_credential_preparation_inconsistent');

    // Same Home, reached through another address: the proof is still produced.
    const builtOverLan = buildE2eeAccountPasswordChangeRequestV1({
      action: 'recover', expectedCredentialRevision: 4,
      accountId: 'account-1', normalizedNativeEmail: 'person@example.test',
      recoverySecret, expectedEnvelope: envelope,
      expectedAudience: { ...challenge.audience, origin: 'http://192.168.1.5:3005' },
      preparation: { targetCredential, challenge },
    });
    expect(builtOverLan.proof).toEqual(built.proof);

    expect(() => buildE2eeAccountPasswordChangeRequestV1({
      action: 'recover', expectedCredentialRevision: 4,
      accountId: 'account-1', normalizedNativeEmail: 'person@example.test',
      recoverySecret, expectedEnvelope: envelope,
      expectedAudience: { ...challenge.audience, serverIdentityId: 'srv_other' },
      preparation: { targetCredential, challenge },
    })).toThrow('password_credential_challenge_identity_mismatch');

    expect(() => buildE2eeAccountPasswordChangeRequestV1({
      action: 'recover', expectedCredentialRevision: 4,
      accountId: 'account-1', normalizedNativeEmail: 'person@example.test',
      recoverySecret: new Uint8Array(32), expectedEnvelope: envelope,
      expectedAudience: challenge.audience,
      preparation: { targetCredential, challenge: { ...challenge, expectedAccountId: 'account-2' } },
    })).toThrow('password_credential_challenge_operation_mismatch');
  });
});
