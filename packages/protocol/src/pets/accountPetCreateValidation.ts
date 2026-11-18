import {
  readCanonicalPaddedBase64DecodedLength,
  decodeBase64,
} from '../crypto/base64.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import {
  AccountPetCreateRequestV1Schema,
  AccountPetOriginV1Schema,
  type AccountPetCreateRequestV1,
  type PetAssetMediaTypeV1,
} from './accountLibrary.js';
import type { PetCellBoundsV1 } from './atlasPixelInspection.js';
import { isAccountPetSpritesheetMediaTypeV1, readPetAtlasImageHeaderV1 } from './atlasImageHeader.js';
import {
  PET_ATLAS_V2,
  PET_PACKAGE_LIMITS_V1,
  getPetAtlasForDimensionsV1,
} from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';
import { computeAccountPetPackageDigestV1 } from './portablePetV1.js';

/** Decoded-atlas facts a platform decoder reports through `inspectPetAtlasRgbaPixelsV1`. */
export type PetAtlasInspectionV1 = Readonly<{
  width: number;
  height: number;
  hasAlpha: boolean;
  hasOpaqueBackground?: boolean;
  hasTransparentBackground?: boolean;
  hasVisibleUsedCells?: boolean;
  hasTransparentUnusedCells?: boolean;
  opaqueBounds?: PetCellBoundsV1 | null;
  hasNeutralLookCell?: boolean;
}>;

export type PetAtlasInspectorV1 = (
  bytes: Uint8Array,
  mediaType: PetAssetMediaTypeV1,
) => Promise<PetAtlasInspectionV1>;

export type AccountPetCreateValidationOptionsV1 = Readonly<{
  maxManifestBytes?: number;
  maxSpritesheetBytes?: number;
  maxPackageBytes?: number;
  inspectAtlas: PetAtlasInspectorV1;
}>;

/** Closed reasons carried to the caller; no package content is included. */
export type AccountPetCreateValidationReasonV1 =
  | 'unexpected_fields'
  | 'schema'
  | 'spritesheet_path'
  | 'manifest_too_large'
  | 'spritesheet_too_large'
  | 'package_too_large'
  | 'spritesheet_encoding'
  | 'spritesheet_size_mismatch'
  | 'spritesheet_media_type'
  | 'spritesheet_digest'
  | 'atlas_contract'
  | 'atlas_decode';

export type AccountPetCreateValidationResultV1 =
  | Readonly<{
      ok: true;
      request: AccountPetCreateRequestV1;
      spritesheetBytes: Uint8Array;
      packageDigest: string;
      opaqueBounds?: PetCellBoundsV1;
      hasNeutralLookCell?: boolean;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid_request';
      error: 'invalid_request';
      reason: AccountPetCreateValidationReasonV1;
    }>;

const TOP_LEVEL_KEYS = new Set(
  Object.keys(AccountPetCreateRequestV1Schema.def.shape),
);
const MANIFEST_KEYS = new Set(
  Object.keys(PetPackageManifestV1Schema.def.shape),
);
const SPRITESHEET_KEYS = new Set(
  Object.keys(AccountPetCreateRequestV1Schema.def.shape.spritesheet.def.shape),
);
const ORIGIN_KEYS_BY_KIND: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  AccountPetOriginV1Schema.def.options.map((schema) => [
    schema.def.shape.kind.def.values[0],
    new Set(Object.keys(schema.def.shape)),
  ]),
);
const textEncoder = new TextEncoder();

function invalid(
  reason: AccountPetCreateValidationReasonV1,
): AccountPetCreateValidationResultV1 {
  return {
    ok: false,
    errorCode: 'invalid_request',
    error: 'invalid_request',
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasUnexpectedKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): boolean {
  if (!isRecord(value)) return true;
  return Object.keys(value).some((key) => !allowedKeys.has(key));
}

function hasUnexpectedOriginKeys(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return true;
  const allowedKeys = ORIGIN_KEYS_BY_KIND.get(value.kind);
  return !allowedKeys || hasUnexpectedKeys(value, allowedKeys);
}

/** POSIX normalization of a package-relative path; the sheet must be the package's root spritesheet. */
function isSafeManifestSpritesheetPath(path: string): boolean {
  const raw = path.replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || raw.includes('\0') || raw.includes(':'))
    return false;
  const parts: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return false;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return (
    parts.length === 1 &&
    (parts[0] === 'spritesheet.webp' || parts[0] === 'spritesheet.png')
  );
}

/** Canonical base64, with or without terminal padding; returns the padded spelling. */
function readCanonicalBase64(
  value: string,
): Readonly<{ padded: string; length: number }> | null {
  const core = value.replace(/=+$/, '');
  if (core.length % 4 === 1) return null;
  const padded = core + '='.repeat((4 - (core.length % 4)) % 4);
  const length = readCanonicalPaddedBase64DecodedLength(padded);
  return length === null || length === 0 ? null : { padded, length };
}

function hasExpectedAtlasPixels(inspection: PetAtlasInspectionV1): boolean {
  return (
    inspection.hasAlpha === true &&
    inspection.hasOpaqueBackground !== true &&
    inspection.hasTransparentBackground !== false &&
    inspection.hasVisibleUsedCells !== false &&
    inspection.hasTransparentUnusedCells !== false
  );
}

/**
 * Account pet package admission. Plain Accounts run it on the Home; E2EE Accounts
 * run it on the writing client before sealing, because the Home sees only ciphertext.
 */
export async function validateAccountPetCreateRequestV1(
  rawRequest: unknown,
  options: AccountPetCreateValidationOptionsV1,
): Promise<AccountPetCreateValidationResultV1> {
  if (
    hasUnexpectedKeys(rawRequest, TOP_LEVEL_KEYS) ||
    !isRecord(rawRequest) ||
    hasUnexpectedKeys(rawRequest.manifest, MANIFEST_KEYS) ||
    hasUnexpectedKeys(rawRequest.spritesheet, SPRITESHEET_KEYS) ||
    hasUnexpectedOriginKeys(rawRequest.origin)
  ) {
    return invalid('unexpected_fields');
  }

  const parsed = AccountPetCreateRequestV1Schema.safeParse(rawRequest);
  if (!parsed.success) return invalid('schema');
  if (!isSafeManifestSpritesheetPath(parsed.data.manifest.spritesheetPath))
    return invalid('spritesheet_path');

  const manifestBytes = textEncoder.encode(
    JSON.stringify(parsed.data.manifest),
  ).byteLength;
  if (
    manifestBytes >
    (options.maxManifestBytes ?? PET_PACKAGE_LIMITS_V1.maxManifestBytes)
  )
    return invalid('manifest_too_large');

  const spritesheet = parsed.data.spritesheet;
  if (
    spritesheet.sizeBytes >
    (options.maxSpritesheetBytes ??
      PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes)
  ) {
    return invalid('spritesheet_too_large');
  }
  if (
    manifestBytes + spritesheet.sizeBytes >
    (options.maxPackageBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes)
  ) {
    return invalid('package_too_large');
  }

  // Use the encoded payload to verify the size claim before allocating decoded bytes.
  const encoded = readCanonicalBase64(spritesheet.data.trim());
  if (!encoded) return invalid('spritesheet_encoding');
  if (encoded.length !== spritesheet.sizeBytes)
    return invalid('spritesheet_size_mismatch');
  const bytes = decodeBase64(encoded.padded);
  if (bytes.byteLength !== spritesheet.sizeBytes)
    return invalid('spritesheet_size_mismatch');
  if (!isAccountPetSpritesheetMediaTypeV1(bytes, spritesheet.mediaType))
    return invalid('spritesheet_media_type');
  if (spritesheet.digest !== `sha256:${computeSha256HexDigest(bytes)}`)
    return invalid('spritesheet_digest');

  const header = readPetAtlasImageHeaderV1(bytes);
  if (!header) return invalid('atlas_decode');
  const atlas = getPetAtlasForDimensionsV1(header.width, header.height);
  if (!atlas) return invalid('atlas_contract');

  let opaqueBounds: PetCellBoundsV1 | undefined;
  let hasNeutralLookCell: boolean | undefined;
  let inspection: PetAtlasInspectionV1;
  try {
    inspection = await options.inspectAtlas(bytes, spritesheet.mediaType);
  } catch {
    return invalid('atlas_decode');
  }
  if (inspection.width !== header.width || inspection.height !== header.height || !hasExpectedAtlasPixels(inspection))
    return invalid('atlas_contract');
  opaqueBounds = inspection.opaqueBounds ?? undefined;
  if (atlas === PET_ATLAS_V2) {
    parsed.data.manifest.spriteVersionNumber = 2;
    hasNeutralLookCell = inspection.hasNeutralLookCell === true;
  } else if (parsed.data.manifest.spriteVersionNumber !== undefined) {
    parsed.data.manifest.spriteVersionNumber = 1;
  }

  return {
    ok: true,
    request: parsed.data,
    spritesheetBytes: bytes,
    packageDigest: computeAccountPetPackageDigestV1(parsed.data.manifest, bytes),
    ...(opaqueBounds ? { opaqueBounds } : {}),
    ...(hasNeutralLookCell !== undefined ? { hasNeutralLookCell } : {}),
  };
}
