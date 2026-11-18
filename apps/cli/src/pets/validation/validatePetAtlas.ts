import { readPetAtlasImageHeaderV1 } from '@happier-dev/protocol/pets/atlasImageHeader';
import { inspectPetAtlasRgbaPixelsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import { getPetAtlasForDimensionsV1 } from '@happier-dev/protocol/pets/constants';
import type { PetAtlasInspectorV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';
import type { PetAssetMediaTypeV1, PetPackageValidationIssueV1 } from '@happier-dev/protocol';

export type PetAtlasValidationResult =
  | Readonly<{ ok: true; mediaType: PetAssetMediaTypeV1; width: number; height: number }>
  | Readonly<{ ok: false; issues: PetPackageValidationIssueV1[] }>;

export type PetImageInfo = Readonly<{
  mediaType: PetAssetMediaTypeV1;
  width: number;
  height: number;
  contentInspected?: boolean;
  hasOpaqueBackground?: boolean;
  hasTransparentBackground?: boolean;
  hasVisibleUsedCells?: boolean;
  hasTransparentUnusedCells?: boolean;
}>;

export type PetImageInfoDecoder = (input: Readonly<{
  bytes: Buffer;
  filename: string;
  strict?: boolean;
  signal?: AbortSignal;
}>) => Promise<PetImageInfo | null> | PetImageInfo | null;

function issue(code: PetPackageValidationIssueV1['code'], message: string): PetPackageValidationIssueV1 {
  return { code, message };
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortedIssue(): PetPackageValidationIssueV1 {
  return issue('internal_error', 'Pet atlas validation was aborted.');
}

async function inspectImageContentWithSharp(input: Readonly<{
  bytes: Buffer;
  mediaType: PetAssetMediaTypeV1;
  signal?: AbortSignal;
}>): Promise<PetImageInfo | null> {
  if (isAborted(input.signal)) return null;
  try {
    const sharp = (await import('sharp')).default;
    if (isAborted(input.signal)) return null;
    const image = sharp(input.bytes, { failOn: 'error' });
    const metadata = await image.metadata();
    if (isAborted(input.signal)) return null;
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const raw = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (isAborted(input.signal)) return null;
    const inspection = inspectPetAtlasRgbaPixelsV1({
      data: raw.data,
      width: raw.info.width,
      height: raw.info.height,
      channels: raw.info.channels,
    });
    return {
      mediaType: input.mediaType,
      width,
      height,
      contentInspected: true,
      ...inspection,
    };
  } catch {
    return null;
  }
}

/**
 * Atlas inspection for the protocol Account package check, run here before sealing for an
 * E2EE Account (the Home cannot decode sealed bytes). Decode failures reject the package.
 */
export const inspectPetAtlasForAccountUpload: PetAtlasInspectorV1 = async (bytes) => {
  const sharp = (await import('sharp')).default;
  const image = sharp(Buffer.from(bytes), { failOn: 'error' });
  const metadata = await image.metadata();
  const raw = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    hasAlpha: Boolean(metadata.hasAlpha),
    ...inspectPetAtlasRgbaPixelsV1({ data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels }),
  };
};

export async function defaultPetImageInfoDecoder(input: Readonly<{
  bytes: Buffer;
  filename: string;
  strict?: boolean;
  signal?: AbortSignal;
}>): Promise<PetImageInfo | null> {
  if (isAborted(input.signal)) return null;
  const headerInfo = readPetAtlasImageHeaderV1(input.bytes);
  if (!headerInfo || input.strict !== true || !getPetAtlasForDimensionsV1(headerInfo.width, headerInfo.height)) {
    return headerInfo;
  }
  if (isAborted(input.signal)) return null;
  return await inspectImageContentWithSharp({
    bytes: input.bytes,
    mediaType: headerInfo.mediaType,
    signal: input.signal,
  }) ?? headerInfo;
}

export async function validatePetAtlasBytes(input: Readonly<{
  bytes: Buffer;
  filename: string;
  strict?: boolean;
  decoder?: PetImageInfoDecoder;
  signal?: AbortSignal;
}>): Promise<PetAtlasValidationResult> {
  if (isAborted(input.signal)) {
    return { ok: false, issues: [abortedIssue()] };
  }
  const decoder = input.decoder ?? defaultPetImageInfoDecoder;
  const info = await decoder({
    bytes: input.bytes,
    filename: input.filename,
    strict: input.strict,
    signal: input.signal,
  });
  if (isAborted(input.signal)) {
    return { ok: false, issues: [abortedIssue()] };
  }
  if (!info) {
    return { ok: false, issues: [issue('spritesheet_invalid_media_type', 'Spritesheet must be PNG or WebP.')] };
  }

  if (!getPetAtlasForDimensionsV1(info.width, info.height)) {
    return { ok: false, issues: [issue('spritesheet_invalid_dimensions', 'Spritesheet dimensions do not match the pet atlas contract.')] };
  }
  if (
    input.strict === true
    && (
      info.contentInspected !== true
      || info.hasOpaqueBackground === true
      || info.hasTransparentBackground === false
      || info.hasVisibleUsedCells === false
      || info.hasTransparentUnusedCells === false
    )
  ) {
    return { ok: false, issues: [issue('spritesheet_opaque_background', 'Spritesheet background must remain transparent.')] };
  }

  return {
    ok: true,
    mediaType: info.mediaType,
    width: info.width,
    height: info.height,
  };
}
