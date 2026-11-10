import tweetnacl from 'tweetnacl';
import { z } from '../zodRuntimePolicy.js';

import {
  AccountPasswordChangeRequestV1Schema,
  AccountPasswordEnrollRequestV1Schema,
  AccountPasswordRemoveRequestV1Schema,
  PasswordMutationPreparationResponseV1Schema,
  type AccountPasswordChangeRequestV1,
  type AccountPasswordEnrollRequestV1,
  type AccountPasswordRemoveRequestV1,
} from './accountSecurity.js';
import {
  E2eeAccountPasswordCredentialV1Schema,
  encodePasswordCredentialFieldV1,
} from './accountPasswordCredential.js';
import type { KeyChallengeV2Audience } from './keyChallenge.js';
import {
  PasswordMutationChallengeProofV1Schema,
  createPasswordCredentialMutationDigestV1,
  createPasswordCredentialTargetDigestV1,
  createPasswordMutationChallengeSigningInputV1,
  type PasswordMutationChallengeProofV1,
  type PasswordMutationChallengeV1,
  type PasswordCredentialMutationV1,
} from './passwordMutationChallenge.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

/** Strictly validates the Home-prepared E2EE target against client-owned bytes. */
export function readE2eePasswordPreparationV1(
  preparation: unknown,
  expectedEnvelope: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>['envelope'],
): Readonly<{
  targetCredential: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>;
  challenge: PasswordMutationChallengeV1 | null;
}> {
  const prepared = PasswordMutationPreparationResponseV1Schema.safeParse(preparation);
  if (!prepared.success || !('targetCredential' in prepared.data)
    || prepared.data.targetCredential.kind !== 'e2ee_password_envelope'
    || createCanonicalJsonSigningInput(prepared.data.targetCredential.envelope)
      !== createCanonicalJsonSigningInput(expectedEnvelope)) {
    throw new Error('password_credential_preparation_inconsistent');
  }
  return {
    targetCredential: prepared.data.targetCredential,
    challenge: prepared.data.challenge ?? null,
  };
}

export function createE2eePasswordMutationChallengeProofV1(
  recoverySecret: Uint8Array,
  challenge: PasswordMutationChallengeV1,
  expectedAudience: Required<KeyChallengeV2Audience>,
  expectedMutation: PasswordCredentialMutationV1,
): PasswordMutationChallengeProofV1 {
  if (recoverySecret.byteLength !== tweetnacl.sign.seedLength) {
    throw new Error('password_credential_recovery_secret_invalid');
  }
  // A mutation proof is only ever built inside an authenticated session for the
  // Account it mutates, so the Home is already established: this device holds a
  // credential proving which Home that identity is. Identity is therefore the
  // binding fact, and the issued origin is accepted as-is because one Home is
  // legitimately reached through other hostnames, ports, tunnels and forwards.
  // First-contact login is stricter and stays address-bound; see docs/api.md.
  if (challenge.audience.serverIdentityId !== expectedAudience.serverIdentityId) {
    throw new Error('password_credential_challenge_identity_mismatch');
  }
  if (challenge.expectedAccountId !== expectedMutation.accountId
    || challenge.operationDigest !== createPasswordCredentialMutationDigestV1(expectedMutation)) {
    throw new Error('password_credential_challenge_operation_mismatch');
  }
  const keyPair = tweetnacl.sign.keyPair.fromSeed(recoverySecret);
  try {
    return PasswordMutationChallengeProofV1Schema.parse({
      challengeId: challenge.challengeId,
      publicKey: encodePasswordCredentialFieldV1(keyPair.publicKey),
      signature: encodePasswordCredentialFieldV1(tweetnacl.sign.detached(
        createPasswordMutationChallengeSigningInputV1(challenge),
        keyPair.secretKey,
      )),
    });
  } finally {
    keyPair.secretKey.fill(0);
  }
}

function assertE2eePasswordPreparationV1(input: Readonly<{
  action: 'connect' | 'change' | 'recover';
  accountId: string;
  expectedCredentialRevision: number | null;
  normalizedNativeEmail: string | null;
  recoverySecret: Uint8Array;
  expectedAudience: Required<KeyChallengeV2Audience>;
  expectedEnvelope: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>['envelope'];
  preparation: unknown;
  verificationToken?: string;
}>): Readonly<{
  targetCredential: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>;
  proof: PasswordMutationChallengeProofV1;
}> {
  const prepared = readE2eePasswordPreparationV1(input.preparation, input.expectedEnvelope);
  if (!prepared.challenge) throw new Error('password_credential_preparation_inconsistent');
  const expectedMutation = {
    v: 1,
    action: input.action,
    accountId: input.accountId,
    expectedCredentialRevision: input.expectedCredentialRevision,
    normalizedNativeEmail: input.normalizedNativeEmail,
    newCredentialDigest: createPasswordCredentialTargetDigestV1(prepared.targetCredential),
  } as const;
  const proof = createE2eePasswordMutationChallengeProofV1(
    input.recoverySecret,
    prepared.challenge,
    input.expectedAudience,
    expectedMutation,
  );
  if (proof.publicKey !== prepared.targetCredential.envelope.accountSigningPublicKey) {
    throw new Error('password_credential_preparation_inconsistent');
  }
  return {
    targetCredential: prepared.targetCredential,
    proof,
  };
}

/** Pure cross-client assembly after the Home prepares the verifier and challenge. */
export function buildE2eeAccountPasswordEnrollRequestV1(input: Readonly<{
  email: string;
  verificationToken?: string;
  accountId: string;
  normalizedNativeEmail: string;
  recoverySecret: Uint8Array;
  expectedAudience: Required<KeyChallengeV2Audience>;
  expectedEnvelope: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>['envelope'];
  preparation: unknown;
}>): Extract<AccountPasswordEnrollRequestV1, { kind: 'e2ee' }> {
  const prepared = assertE2eePasswordPreparationV1({
    ...input, action: 'connect', expectedCredentialRevision: null,
  });
  return AccountPasswordEnrollRequestV1Schema.parse({
    v: 1, kind: 'e2ee', email: input.email,
    ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
    targetCredential: prepared.targetCredential, proof: prepared.proof,
  }) as Extract<AccountPasswordEnrollRequestV1, { kind: 'e2ee' }>;
}

/** Pure cross-client assembly for ordinary and recovery password replacement. */
export function buildE2eeAccountPasswordChangeRequestV1(input: Readonly<{
  action: 'change' | 'recover';
  accountId: string;
  normalizedNativeEmail: string | null;
  expectedCredentialRevision: number;
  recoverySecret: Uint8Array;
  expectedAudience: Required<KeyChallengeV2Audience>;
  expectedEnvelope: z.infer<typeof E2eeAccountPasswordCredentialV1Schema>['envelope'];
  preparation: unknown;
}>): Extract<AccountPasswordChangeRequestV1, { kind: 'e2ee' }> {
  const prepared = assertE2eePasswordPreparationV1(input);
  return AccountPasswordChangeRequestV1Schema.parse({
    v: 1, kind: 'e2ee', action: input.action,
    expectedCredentialRevision: input.expectedCredentialRevision,
    targetCredential: prepared.targetCredential, proof: prepared.proof,
  }) as Extract<AccountPasswordChangeRequestV1, { kind: 'e2ee' }>;
}

/** Pure cross-client assembly for removing only the password wrapper/locator. */
export function buildE2eeAccountPasswordRemoveRequestV1(input: Readonly<{
  accountId: string;
  normalizedNativeEmail: string | null;
  expectedCredentialRevision: number;
  recoverySecret: Uint8Array;
  expectedAudience: Required<KeyChallengeV2Audience>;
  preparation: unknown;
}>): Extract<AccountPasswordRemoveRequestV1, { kind: 'e2ee' }> {
  const prepared = PasswordMutationPreparationResponseV1Schema.safeParse(input.preparation);
  if (!prepared.success || !('challenge' in prepared.data) || !prepared.data.challenge) {
    throw new Error('password_credential_preparation_inconsistent');
  }
  const expectedMutation = {
    v: 1, action: 'remove', accountId: input.accountId,
    expectedCredentialRevision: input.expectedCredentialRevision,
    normalizedNativeEmail: input.normalizedNativeEmail,
    newCredentialDigest: null,
  } as const;
  return AccountPasswordRemoveRequestV1Schema.parse({
    v: 1, kind: 'e2ee', expectedCredentialRevision: input.expectedCredentialRevision,
    proof: createE2eePasswordMutationChallengeProofV1(
      input.recoverySecret,
      prepared.data.challenge,
      input.expectedAudience,
      expectedMutation,
    ),
  }) as Extract<AccountPasswordRemoveRequestV1, { kind: 'e2ee' }>;
}
