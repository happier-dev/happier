import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  PET_PACKAGE_LIMITS_V1,
  type PetAssetMediaTypeV1,
  type PetPackageSourceV1,
} from '@happier-dev/protocol';

import { createPetSourceKey } from '../discovery/createPetSourceKey';
import { validatePetManifestBytes } from '../validation/validatePetManifest';
import { validatePetPackage } from '../validation/validatePetPackage';
import { validatePetAtlasBytes } from '../validation/validatePetAtlas';

export type PetAssetReadResult =
  | Readonly<{
    ok: true;
    mediaType: PetAssetMediaTypeV1;
    encoding: 'base64';
    data: string;
    sizeBytes: number;
    digest: string;
  }>
  | Readonly<{
    ok: false;
    errorCode: 'invalid_request' | 'not_found' | 'payload_too_large' | 'validation_failed' | 'unsupported_source' | 'internal_error';
    error: string;
  }>;

function isExpectedSourceKey(source: PetPackageSourceV1, digest: string): boolean {
  if (source.kind === 'detectedCodexHome') {
    return source.sourceKey === createPetSourceKey(['detectedCodexHome', source.homeKind, source.packagePath, digest]);
  }
  if (source.kind === 'happierManagedLocal') {
    return source.sourceKey === createPetSourceKey(['happierManagedLocal', source.packagePath, digest]);
  }
  return false;
}

export async function readPetAsset(input: Readonly<{
  source: PetPackageSourceV1;
  maxBytes?: number;
}>): Promise<PetAssetReadResult> {
  if (input.source.kind !== 'detectedCodexHome' && input.source.kind !== 'happierManagedLocal') {
    return { ok: false, errorCode: 'unsupported_source', error: 'Pet source does not refer to a local package.' };
  }

  const validation = await validatePetPackage({ packagePath: input.source.packagePath });
  if (!validation.ok) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.' };
  }
  if (!isExpectedSourceKey(input.source, validation.digest)) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Pet source key is not recognized for this package.' };
  }

  const maxBytes = input.maxBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes;
  const assetStats = await stat(validation.spritesheetPath).catch(() => null);
  if (!assetStats?.isFile()) {
    return { ok: false, errorCode: 'not_found', error: 'Pet asset not found.' };
  }
  if (assetStats.size > maxBytes) {
    return { ok: false, errorCode: 'payload_too_large', error: 'Pet asset exceeds maximum payload size.' };
  }

  const bytes = await readFile(validation.spritesheetPath);
  const manifestBytes = await readFile(join(input.source.packagePath, 'pet.json')).catch(() => null);
  if (!manifestBytes) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.' };
  }
  const manifest = validatePetManifestBytes(manifestBytes);
  if (!manifest.ok || manifest.manifest.spritesheetPath !== validation.manifest.spritesheetPath) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.' };
  }
  const atlas = await validatePetAtlasBytes({
    bytes,
    filename: basename(validation.spritesheetPath),
  });
  if (!atlas.ok) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.' };
  }
  const digest = `sha256:${createHash('sha256').update(manifestBytes).update(bytes).digest('hex')}`;
  if (!isExpectedSourceKey(input.source, digest)) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Pet source key is not recognized for this package.' };
  }
  return {
    ok: true,
    mediaType: atlas.mediaType,
    encoding: 'base64',
    data: bytes.toString('base64'),
    sizeBytes: bytes.byteLength,
    digest,
  };
}
