import type { AccountEncryptionMode } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import {
  SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionOwnerMetadataV1Schema,
  validateSessionOwnerMetadataEnvelopeForAccountModeV1,
  type SessionOwnerMetadataV1,
  type SessionOwnerMetadataEnvelopeV1,
  type OpenSessionOwnerMetadataEnvelopeV1Result,
} from './sessionMetadataSchemasV1.js';

// Crypto operations retain the incumbent entry point; portable schema consumers use the leaf.
export * from './sessionMetadataSchemasV1.js';

export function sealSessionOwnerMetadataV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ownerMetadata: SessionOwnerMetadataV1;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  const ownerMetadata = SessionOwnerMetadataV1Schema.parse(
    params.ownerMetadata,
  );
  return sealAccountScopedBlobCiphertext({
    kind: SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND,
    material: params.material,
    payload: ownerMetadata,
    randomBytes: params.randomBytes,
  });
}

export function sealSessionOwnerMetadataEnvelopeV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ownerMetadata: SessionOwnerMetadataV1;
  randomBytes: (length: number) => Uint8Array;
}>): SessionOwnerMetadataEnvelopeV1 {
  return {
    t: 'encrypted',
    c: sealSessionOwnerMetadataV1(params),
  };
}

export function openSessionOwnerMetadataEnvelopeV1(params: Readonly<{
  accountMode: AccountEncryptionMode;
  envelope: unknown;
  material?: AccountScopedCryptoMaterial | null;
}>): OpenSessionOwnerMetadataEnvelopeV1Result {
  const stored = createStoredReadSchema(SessionOwnerMetadataEnvelopeV1Schema).safeParse(params.envelope);
  const validated = validateSessionOwnerMetadataEnvelopeForAccountModeV1(
    { ...params, envelope: stored.success ? stored.data : params.envelope },
  );
  if (!validated.ok) return validated;
  if (validated.envelope.t === 'plain') {
    return { ok: true, ownerMetadata: validated.envelope.v };
  }
  if (!params.material) {
    return { ok: false, reason: 'material_unavailable' };
  }
  const ownerMetadata = openSessionOwnerMetadataV1({
    material: params.material,
    ciphertext: validated.envelope.c,
  });
  return ownerMetadata
    ? { ok: true, ownerMetadata }
    : { ok: false, reason: 'invalid_ciphertext' };
}

export function openSessionOwnerMetadataV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): SessionOwnerMetadataV1 | null {
  const opened = openAccountScopedBlobCiphertext({
    kind: SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND,
    material: params.material,
    ciphertext: params.ciphertext,
  });
  if (
    !opened
    || opened.format !== 'account_scoped_v1'
    || opened.kindTag !== 'canonical'
  ) {
    return null;
  }
  const parsed = createStoredReadSchema(SessionOwnerMetadataV1Schema).safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

export function rewrapSessionOwnerMetadataV1(params: Readonly<{
  sourceMaterial: AccountScopedCryptoMaterial;
  targetMaterial: AccountScopedCryptoMaterial;
  ciphertext: string;
  randomBytes: (length: number) => Uint8Array;
}>): string | null {
  const ownerMetadata = openSessionOwnerMetadataV1({
    material: params.sourceMaterial,
    ciphertext: params.ciphertext,
  });
  if (!ownerMetadata) return null;
  return sealSessionOwnerMetadataV1({
    material: params.targetMaterial,
    ownerMetadata,
    randomBytes: params.randomBytes,
  });
}
