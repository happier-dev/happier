import {
  inspectPetAtlasRgbaPixelsV1,
  PET_ATLAS_V1,
  type PetAssetMediaTypeV1,
  type PetPackageValidationIssueV1,
} from '@happier-dev/protocol';

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

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function readPngInfo(bytes: Buffer): PetImageInfo | null {
  if (!isPng(bytes)) return null;
  return {
    mediaType: 'image/png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readWebpChunkInfo(bytes: Buffer, chunkOffset: number): PetImageInfo | null {
  const chunkType = bytes.toString('ascii', chunkOffset, chunkOffset + 4);
  const dataOffset = chunkOffset + 8;
  if (chunkType === 'VP8X' && bytes.length >= dataOffset + 10) {
    const width = 1 + bytes.readUIntLE(dataOffset + 4, 3);
    const height = 1 + bytes.readUIntLE(dataOffset + 7, 3);
    return { mediaType: 'image/webp', width, height };
  }
  if (chunkType === 'VP8 ' && bytes.length >= dataOffset + 10) {
    const startCodeOffset = dataOffset + 3;
    if (bytes[startCodeOffset] !== 0x9d || bytes[startCodeOffset + 1] !== 0x01 || bytes[startCodeOffset + 2] !== 0x2a) {
      return null;
    }
    const width = bytes.readUInt16LE(dataOffset + 6) & 0x3fff;
    const height = bytes.readUInt16LE(dataOffset + 8) & 0x3fff;
    return { mediaType: 'image/webp', width, height };
  }
  if (chunkType === 'VP8L' && bytes.length >= dataOffset + 5 && bytes[dataOffset] === 0x2f) {
    const b0 = bytes[dataOffset + 1]!;
    const b1 = bytes[dataOffset + 2]!;
    const b2 = bytes[dataOffset + 3]!;
    const b3 = bytes[dataOffset + 4]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { mediaType: 'image/webp', width, height };
  }
  return null;
}

function readWebpInfo(bytes: Buffer): PetImageInfo | null {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const info = readWebpChunkInfo(bytes, offset);
    if (info) return info;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
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

export async function defaultPetImageInfoDecoder(input: Readonly<{
  bytes: Buffer;
  filename: string;
  strict?: boolean;
  signal?: AbortSignal;
}>): Promise<PetImageInfo | null> {
  if (isAborted(input.signal)) return null;
  const headerInfo = readPngInfo(input.bytes) ?? readWebpInfo(input.bytes);
  if (!headerInfo || input.strict !== true) return headerInfo;
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

  if (info.width !== PET_ATLAS_V1.width || info.height !== PET_ATLAS_V1.height) {
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
