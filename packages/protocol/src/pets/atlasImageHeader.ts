import type { PetAssetMediaTypeV1 } from './accountLibrary.js';

type PetAtlasImageHeader = Readonly<{
  mediaType: PetAssetMediaTypeV1;
  width: number;
  height: number;
  hasOpaqueBackground?: boolean;
}>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fourCC(data: DataView, offset: number): string {
  return String.fromCharCode(
    data.getUint8(offset), data.getUint8(offset + 1),
    data.getUint8(offset + 2), data.getUint8(offset + 3),
  );
}

function readImageMediaType(data: DataView): PetAssetMediaTypeV1 | null {
  if (data.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, offset) => data.getUint8(offset) === byte)) {
    return 'image/png';
  }
  if (data.byteLength >= 12 && fourCC(data, 0) === 'RIFF' && fourCC(data, 8) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function isAccountPetSpritesheetMediaTypeV1(bytes: Uint8Array, mediaType: PetAssetMediaTypeV1): boolean {
  return readImageMediaType(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) === mediaType;
}

function readPngInfo(data: DataView): PetAtlasImageHeader | null {
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType: number | null = null;
  let hasTransparencyChunk = false;
  let hasImageData = false;

  while (offset + 12 <= data.byteLength) {
    const chunkLength = data.getUint32(offset);
    const chunkType = fourCC(data, offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkLength + 4;
    if (nextOffset > data.byteLength) return null;

    if (chunkType === 'IHDR') {
      if (offset !== PNG_SIGNATURE.length || chunkLength !== 13) return null;
      width = data.getUint32(dataOffset);
      height = data.getUint32(dataOffset + 4);
      colorType = data.getUint8(dataOffset + 9);
      if (![0, 2, 3, 4, 6].includes(colorType)) return null;
    } else if (chunkType === 'tRNS') {
      hasTransparencyChunk = true;
    } else if (chunkType === 'IDAT') {
      hasImageData = true;
    } else if (chunkType === 'IEND') {
      if (chunkLength !== 0 || !hasImageData || colorType === null) return null;
      const hasAlpha = colorType === 4 || colorType === 6 || hasTransparencyChunk;
      return { mediaType: 'image/png', width, height, hasOpaqueBackground: !hasAlpha };
    }
    offset = nextOffset;
  }
  return null;
}

function readUint24LE(data: DataView, offset: number): number {
  return data.getUint16(offset, true) | (data.getUint8(offset + 2) << 16);
}

function readWebpChunkInfo(data: DataView, chunkOffset: number, chunkSize: number): PetAtlasImageHeader | null {
  const chunkType = fourCC(data, chunkOffset);
  const offset = chunkOffset + 8;
  if (chunkType === 'VP8X' && chunkSize >= 10) {
    const width = 1 + readUint24LE(data, offset + 4);
    const height = 1 + readUint24LE(data, offset + 7);
    return { mediaType: 'image/webp', width, height };
  }
  if (chunkType === 'VP8 ' && chunkSize >= 10) {
    if (readUint24LE(data, offset + 3) !== 0x2a019d) return null;
    const width = data.getUint16(offset + 6, true) & 0x3fff;
    const height = data.getUint16(offset + 8, true) & 0x3fff;
    return { mediaType: 'image/webp', width, height, hasOpaqueBackground: true };
  }
  if (chunkType === 'VP8L' && chunkSize >= 5 && data.getUint8(offset) === 0x2f) {
    const packed = data.getUint32(offset + 1, true);
    const width = 1 + (packed & 0x3fff);
    const height = 1 + ((packed >>> 14) & 0x3fff);
    return { mediaType: 'image/webp', width, height };
  }
  return null;
}

function readWebpInfo(data: DataView): PetAtlasImageHeader | null {
  const riffEnd = data.getUint32(4, true) + 8;
  if (riffEnd > data.byteLength) return null;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkSize = data.getUint32(offset + 4, true);
    if (offset + 8 + chunkSize > riffEnd) return null;
    const info = readWebpChunkInfo(data, offset, chunkSize);
    if (info) return info;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

/** Read header dimensions without decompressing image data. */
export function readPetAtlasImageHeaderV1(bytes: Uint8Array): PetAtlasImageHeader | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mediaType = readImageMediaType(data);
  if (mediaType === 'image/png') return readPngInfo(data);
  if (mediaType === 'image/webp') return readWebpInfo(data);
  return null;
}
