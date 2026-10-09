import tweetnacl from 'tweetnacl';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1 } from '../providers/migrations/legacyProfilesV1.js';
import type { ProviderContributionV1 } from '../providers/contributions/v1.js';
import {
  ProfileRecordV1Schema, StoredProfileRecordV1Schema,
  parseStoredProfileRecordContentV1, assertProfileRecordContentForModeV1,
  hasUnrepresentedProfileSavedSecretReferencesV1, hasUnsupportedLegacyProfileDefinitionVersionV1, PROFILE_RECORD_ACCOUNT_SCOPED_BLOB_KIND_V1,
  resolveEffectiveProfileSecretBindingsV1,
  type ProfileRecordV1, type ProfileRecordContentV1,
} from './profileRecordSchemaV1.js';

// Retain the incumbent public facade and exact schema identities. Schema-only
// consumers import the crypto-free owner rather than evaluating runtime codecs.
export * from './profileRecordSchemaV1.js';

export class ProfileSecretPromotionRequiredError extends Error {
  readonly code = 'profile-secret-promotion-required' as const;
  constructor() { super('profile-secret-promotion-required'); this.name = 'ProfileSecretPromotionRequiredError'; }
}

/** Credential-role classification stays with the incumbent Provider migration owner. */
export function assertProfileRecordSecretMaterialPromotedV1(record: ProfileRecordV1,
  providerContributions: readonly Pick<ProviderContributionV1, 'legacyProfileMigrations'>[] = [],
): void {
  if (record.definition.kind === 'artifact') return;
  const profile = record.definition.profile;
  const environmentVariables = record.definition.kind === 'inline'
    ? record.definition.profile.extraEnvironmentVariables : record.definition.profile.environmentVariables;
  if (listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1({ environmentVariables,
    envVarRequirements: profile.envVarRequirements ?? [] }, providerContributions,
    resolveEffectiveProfileSecretBindingsV1({}, record.secretBindings)).length > 0) {
    throw new ProfileSecretPromotionRequiredError();
  }
}

/** Identity is authenticated inside the Account payload, never inferred from ciphertext. */
export function openProfileRecordContentV1(input: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  expectedId: string; content: unknown;
}>): Readonly<{ status: 'opened'; record: ProfileRecordV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const content = parseStoredProfileRecordContentV1(input.content);
  if (content === null) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertProfileRecordContentForModeV1(content, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let payload: unknown;
  if (content.t === 'plain') payload = content.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    payload = openAccountScopedBlobCiphertext({ kind: PROFILE_RECORD_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material, ciphertext: content.c })?.value;
  }
  const record = StoredProfileRecordV1Schema.safeParse(payload);
  return record.success && record.data.id === input.expectedId && !hasUnsupportedLegacyProfileDefinitionVersionV1(payload)
    && !hasUnrepresentedProfileSavedSecretReferencesV1(payload, record.data)
    ? { status: 'opened', record: record.data }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

export function sealProfileRecordContentV1(input: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  record: ProfileRecordV1; randomBytes?: (length: number) => Uint8Array;
  providerContributions?: readonly Pick<ProviderContributionV1, 'legacyProfileMigrations'>[];
}>): ProfileRecordContentV1 {
  const record = ProfileRecordV1Schema.parse(input.record);
  assertProfileRecordSecretMaterialPromotedV1(record, input.providerContributions);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
    kind: PROFILE_RECORD_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material,
    payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes,
  }) };
}
