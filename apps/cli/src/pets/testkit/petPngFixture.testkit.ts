import { deflateSync } from 'node:zlib';

import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } from '@happier-dev/protocol';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Buffer): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function createPngFromRgbaRows(raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PET_ATLAS_V1.width, 0);
  ihdr.writeUInt32BE(PET_ATLAS_V1.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createFilteredRgbaRows(fill?: Readonly<[number, number, number, number]>): Buffer {
  const bytesPerRow = 1 + PET_ATLAS_V1.width * 4;
  const raw = Buffer.alloc(bytesPerRow * PET_ATLAS_V1.height);
  for (let y = 0; y < PET_ATLAS_V1.height; y += 1) {
    const rowOffset = y * bytesPerRow;
    raw[rowOffset] = 0;
    if (fill) {
      for (let x = 0; x < PET_ATLAS_V1.width; x += 1) {
        const offset = rowOffset + 1 + x * 4;
        raw[offset] = fill[0];
        raw[offset + 1] = fill[1];
        raw[offset + 2] = fill[2];
        raw[offset + 3] = fill[3];
      }
    }
  }
  return raw;
}

function writeVisibleCellMarker(raw: Buffer, row: number, frame: number): void {
  const markerSize = 24;
  const startX = frame * PET_ATLAS_V1.cellWidth + Math.floor((PET_ATLAS_V1.cellWidth - markerSize) / 2);
  const startY = row * PET_ATLAS_V1.cellHeight + Math.floor((PET_ATLAS_V1.cellHeight - markerSize) / 2);
  const bytesPerRow = 1 + PET_ATLAS_V1.width * 4;

  for (let y = startY; y < startY + markerSize; y += 1) {
    for (let x = startX; x < startX + markerSize; x += 1) {
      const offset = y * bytesPerRow + 1 + x * 4;
      raw[offset] = 40 + ((row * 29) % 180);
      raw[offset + 1] = 60 + ((frame * 31) % 160);
      raw[offset + 2] = 90 + (((row + frame) * 17) % 140);
      raw[offset + 3] = 255;
    }
  }
}

export function createTransparentPetSpritesheetPng(): Buffer {
  const raw = createFilteredRgbaRows();
  for (const row of PET_ANIMATION_ROWS_V1) {
    for (let frame = 0; frame < row.frames; frame += 1) {
      writeVisibleCellMarker(raw, row.row, frame);
    }
  }
  return createPngFromRgbaRows(raw);
}

export function createOpaqueWhitePetSpritesheetPng(): Buffer {
  return createPngFromRgbaRows(createFilteredRgbaRows([255, 255, 255, 255]));
}

export async function createTransparentPetSpritesheetWebp(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return await sharp(createTransparentPetSpritesheetPng()).webp({ lossless: true }).toBuffer();
}
