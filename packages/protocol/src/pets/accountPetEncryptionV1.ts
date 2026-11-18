import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import {
  decodeBase64,
  encodeBase64,
  readCanonicalPaddedBase64DecodedLength,
} from '../crypto/base64.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import {
  ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES,
  getAccountScopedBlobCiphertextBase64LengthV1,
  getAccountScopedBlobKindByte,
  isAccountScopedBlobCiphertextForKind,
  readAccountScopedCiphertextKindByte,
} from '../crypto/accountScopedCipherEnvelope.js';
import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  AccountPetEncryptedCreateRequestV1Schema,
  AccountPetLibraryEntryV1Schema,
  AccountPetOriginV1Schema,
  PetAssetMediaTypeV1Schema,
  isAccountPetEncryptedLibraryEntryV1,
  type AccountPetEncryptedCreateRequestV1,
  type AccountPetEncryptedLibraryEntryV1,
  type AccountPetLibraryEntryV1,
  type AccountPetStoredLibraryEntryV1,
  type PetAssetMediaTypeV1,
} from './accountLibrary.js';
import { PetCellBoundsV1Schema } from './atlasPixelInspection.js';
import {
  isAccountPetSpritesheetMediaTypeV1,
  type AccountPetCreateValidationResultV1,
} from './accountPetCreateValidation.js';
import { PET_PACKAGE_LIMITS_V1 } from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';
import { computeAccountPetPackageDigestV1 } from './portablePetV1.js';

export const ACCOUNT_PET_METADATA_BLOB_KIND_V1 =
  'account_pet_metadata' as const;
export const ACCOUNT_PET_SPRITESHEET_BLOB_KIND_V1 =
  'account_pet_spritesheet' as const;

/** Sealed library content: everything the Plain shape carries that is not Home-visible metadata. */
export const AccountPetSealedMetadataV1Schema = lazyZodSchema(() =>
  z.strictObject({
    manifest: PetPackageManifestV1Schema,
    origin: AccountPetOriginV1Schema,
    spritesheet: z.strictObject({
      mediaType: PetAssetMediaTypeV1Schema,
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
      sizeBytes: z.number().check(z.int(), z.minimum(1)),
    }),
    /** Plaintext package digest (`computeAccountPetPackageDigestV1`), for client-side reuse. */
    digest: z.string().check(z.minLength(1), z.maxLength(500)),
    opaqueBounds: z.optional(PetCellBoundsV1Schema),
    hasNeutralLookCell: z.optional(z.boolean()),
  }),
);

export type AccountPetSealedMetadataV1 = z.infer<
  typeof AccountPetSealedMetadataV1Schema
>;

const textEncoder = new TextEncoder();
const SECRETBOX_FRAME_BYTES =
  ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES +
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES +
  ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES;

/** The sealed spritesheet payload is the JSON string of its padded base64. */
function sealedSpritesheetPlaintextBytes(spritesheetBytes: number): number {
  return 2 + 4 * Math.ceil(spritesheetBytes / 3);
}

/**
 * Ciphertext bounds derived from the canonical package limits; the Home enforces
 * these on E2EE writes instead of decoding content it cannot read.
 */
export const ACCOUNT_PET_ENCRYPTED_LIMITS_V1 = Object.freeze({
  maxSealedMetadataBytes: PET_PACKAGE_LIMITS_V1.maxManifestBytes,
  maxContentCiphertextChars: getAccountScopedBlobCiphertextBase64LengthV1(
    PET_PACKAGE_LIMITS_V1.maxManifestBytes,
  ),
  maxSpritesheetCiphertextBytes:
    SECRETBOX_FRAME_BYTES +
    sealedSpritesheetPlaintextBytes(
      PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
    ),
});

export type AccountPetSealResultV1 =
  | Readonly<{ ok: true; request: AccountPetEncryptedCreateRequestV1 }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid_request';
      error: 'invalid_request';
      reason: 'manifest_too_large';
    }>;

/** Seal a package the writing client already admitted with `validateAccountPetCreateRequestV1`. */
export function sealAccountPetPackageV1(
  input: Readonly<{
    validated: Extract<AccountPetCreateValidationResultV1, { ok: true }>;
    material: AccountScopedCryptoMaterial;
    randomBytes: (length: number) => Uint8Array;
  }>,
): AccountPetSealResultV1 {
  const { request, spritesheetBytes } = input.validated;
  const metadata: AccountPetSealedMetadataV1 = {
    manifest: request.manifest,
    origin: request.origin,
    spritesheet: {
      mediaType: request.spritesheet.mediaType,
      digest: request.spritesheet.digest,
      sizeBytes: request.spritesheet.sizeBytes,
    },
    digest: computeAccountPetPackageDigestV1(
      request.manifest,
      spritesheetBytes,
    ),
    ...(input.validated.opaqueBounds
      ? { opaqueBounds: input.validated.opaqueBounds }
      : {}),
    ...(input.validated.hasNeutralLookCell !== undefined
      ? { hasNeutralLookCell: input.validated.hasNeutralLookCell }
      : {}),
  };
  if (
    textEncoder.encode(JSON.stringify(metadata)).byteLength >
    ACCOUNT_PET_ENCRYPTED_LIMITS_V1.maxSealedMetadataBytes
  ) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
      reason: 'manifest_too_large',
    };
  }
  const content = sealAccountScopedBlobCiphertext({
    kind: ACCOUNT_PET_METADATA_BLOB_KIND_V1,
    material: input.material,
    payload: metadata,
    randomBytes: input.randomBytes,
  });
  const spritesheet = sealAccountScopedBlobCiphertext({
    kind: ACCOUNT_PET_SPRITESHEET_BLOB_KIND_V1,
    material: input.material,
    payload: encodeBase64(spritesheetBytes),
    randomBytes: input.randomBytes,
  });
  const ciphertextBytes = decodeBase64(spritesheet);
  return {
    ok: true,
    request: {
      content: { t: 'encrypted', c: content },
      spritesheet: {
        encoding: 'base64',
        data: spritesheet,
        sizeBytes: ciphertextBytes.byteLength,
        digest: `sha256:${computeSha256HexDigest(ciphertextBytes)}`,
      },
    },
  };
}

export type AccountPetEncryptedCreateAdmissionV1 = Readonly<{
  content: Readonly<{ t: 'encrypted'; c: string }>;
  spritesheetCiphertext: Uint8Array;
  spritesheetDigest: string;
}>;

/**
 * Home admission of an E2EE create: structure, ciphertext domains and the derived
 * size bounds. The Home cannot and does not inspect the sealed package.
 */
export function admitAccountPetEncryptedCreateRequestV1(
  raw: unknown,
): AccountPetEncryptedCreateAdmissionV1 | null {
  const parsed = AccountPetEncryptedCreateRequestV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const { content, spritesheet } = parsed.data;
  if (
    content.c.length >
      ACCOUNT_PET_ENCRYPTED_LIMITS_V1.maxContentCiphertextChars ||
    readAccountScopedCiphertextKindByte(content.c, 'canonical') !==
      getAccountScopedBlobKindByte(ACCOUNT_PET_METADATA_BLOB_KIND_V1)
  ) {
    return null;
  }
  if (
    spritesheet.sizeBytes >
      ACCOUNT_PET_ENCRYPTED_LIMITS_V1.maxSpritesheetCiphertextBytes ||
    readCanonicalPaddedBase64DecodedLength(spritesheet.data) !==
      spritesheet.sizeBytes ||
    readAccountScopedCiphertextKindByte(spritesheet.data, 'canonical') !==
      getAccountScopedBlobKindByte(ACCOUNT_PET_SPRITESHEET_BLOB_KIND_V1)
  ) {
    return null;
  }
  const spritesheetCiphertext = decodeBase64(spritesheet.data);
  const digest = `sha256:${computeSha256HexDigest(spritesheetCiphertext)}`;
  if (digest !== spritesheet.digest) return null;
  return { content, spritesheetCiphertext, spritesheetDigest: digest };
}

/** True when the wire create request is the E2EE shape; Plain requests carry a manifest instead. */
export function isAccountPetEncryptedCreateRequestV1(raw: unknown): boolean {
  return Boolean(
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'content' in raw,
  );
}

/** Open one E2EE library entry; any decrypt, domain or shape failure is `null`, never plaintext. */
export function openAccountPetLibraryEntryV1(
  entry: AccountPetEncryptedLibraryEntryV1,
  material: AccountScopedCryptoMaterial,
): AccountPetLibraryEntryV1 | null {
  if (
    !isAccountScopedBlobCiphertextForKind({
      kind: ACCOUNT_PET_METADATA_BLOB_KIND_V1,
      ciphertext: entry.content.c,
    })
  )
    return null;
  let opened: unknown;
  try {
    opened = openAccountScopedBlobCiphertext({
      kind: ACCOUNT_PET_METADATA_BLOB_KIND_V1,
      material,
      ciphertext: entry.content.c,
    })?.value;
  } catch {
    return null;
  }
  const metadata = AccountPetSealedMetadataV1Schema.safeParse(opened);
  if (!metadata.success) return null;
  const value = metadata.data;
  const parsed = AccountPetLibraryEntryV1Schema.safeParse({
    accountPetId: entry.accountPetId,
    packageFormat: entry.packageFormat,
    manifest: value.manifest,
    spritesheetAssetRef: {
      assetId: entry.spritesheetAssetRef.assetId,
      mediaType: value.spritesheet.mediaType,
      digest: value.spritesheet.digest,
      sizeBytes: value.spritesheet.sizeBytes,
    },
    digest: value.digest,
    sizeBytes: entry.sizeBytes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    origin: value.origin,
    ...(value.opaqueBounds ? { opaqueBounds: value.opaqueBounds } : {}),
    ...(value.hasNeutralLookCell !== undefined
      ? { hasNeutralLookCell: value.hasNeutralLookCell }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

export type AccountPetEntryOpenModeV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; material: AccountScopedCryptoMaterial }>;

/**
 * Mode/envelope check at the client read boundary: a Plain Account reads only plaintext
 * entries and an E2EE Account only sealed ones. A mismatch or failed open is `null`.
 */
export function openAccountPetStoredEntryForModeV1(
  entry: AccountPetStoredLibraryEntryV1,
  account: AccountPetEntryOpenModeV1,
): AccountPetLibraryEntryV1 | null {
  if (isAccountPetEncryptedLibraryEntryV1(entry)) {
    return account.mode === 'e2ee'
      ? openAccountPetLibraryEntryV1(entry, account.material)
      : null;
  }
  return account.mode === 'plain' ? entry : null;
}

/** Open the served spritesheet ciphertext and bind it to the opened entry's digest and media type. */
export function openAccountPetSpritesheetV1(
  input: Readonly<{
    ciphertext: Uint8Array;
    material: AccountScopedCryptoMaterial;
    expected: Readonly<{ mediaType: PetAssetMediaTypeV1; digest: string }>;
  }>,
): Uint8Array | null {
  const ciphertext = encodeBase64(input.ciphertext);
  if (
    !isAccountScopedBlobCiphertextForKind({
      kind: ACCOUNT_PET_SPRITESHEET_BLOB_KIND_V1,
      ciphertext,
    })
  )
    return null;
  let opened: unknown;
  try {
    opened = openAccountScopedBlobCiphertext({
      kind: ACCOUNT_PET_SPRITESHEET_BLOB_KIND_V1,
      material: input.material,
      ciphertext,
    })?.value;
  } catch {
    return null;
  }
  if (
    typeof opened !== 'string' ||
    readCanonicalPaddedBase64DecodedLength(opened) === null
  )
    return null;
  const bytes = decodeBase64(opened);
  if (`sha256:${computeSha256HexDigest(bytes)}` !== input.expected.digest)
    return null;
  return isAccountPetSpritesheetMediaTypeV1(bytes, input.expected.mediaType)
    ? bytes
    : null;
}
