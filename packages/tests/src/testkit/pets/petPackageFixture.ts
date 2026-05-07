import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import { AccountPetCreateRequestV1Schema, type AccountPetCreateRequestV1, type AccountPetOriginV1 } from '@happier-dev/protocol';

export const minimalPetPngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const atlasColumns = 8;
const atlasRows = 9;
const cellWidth = 192;
const cellHeight = 208;
const atlasWidth = atlasColumns * cellWidth;
const atlasHeight = atlasRows * cellHeight;
const usedFramesByRow = [6, 8, 8, 4, 5, 8, 6, 6, 6] as const;

export type MinimalCodexPetPackageFixture = Readonly<{
  packageDir: string;
  manifestPath: string;
  spritesheetPath: string;
}>;

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

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function writeVisibleCellMarker(raw: Buffer, row: number, frame: number): void {
  const markerSize = 24;
  const startX = frame * cellWidth + Math.floor((cellWidth - markerSize) / 2);
  const startY = row * cellHeight + Math.floor((cellHeight - markerSize) / 2);
  const color = [
    40 + ((row * 29) % 180),
    60 + ((frame * 31) % 160),
    90 + (((row + frame) * 17) % 140),
    255,
  ] as const;

  for (let y = startY; y < startY + markerSize; y += 1) {
    for (let x = startX; x < startX + markerSize; x += 1) {
      const offset = y * (1 + atlasWidth * 4) + 1 + x * 4;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
    }
  }
}

function createMinimalPetSpritesheetPng(): Buffer {
  const bytesPerRow = 1 + atlasWidth * 4;
  const raw = Buffer.alloc(bytesPerRow * atlasHeight);
  for (let y = 0; y < atlasHeight; y += 1) {
    raw[y * bytesPerRow] = 0;
  }
  for (let row = 0; row < usedFramesByRow.length; row += 1) {
    for (let frame = 0; frame < usedFramesByRow[row]!; frame += 1) {
      writeVisibleCellMarker(raw, row, frame);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(atlasWidth, 0);
  ihdr.writeUInt32BE(atlasHeight, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    minimalPetPngSignature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', deflateSync(raw, { level: 9 })),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function createMinimalCodexPetPackage(params: Readonly<{
  rootDir: string;
  petId: string;
  displayName?: string;
}>): Promise<MinimalCodexPetPackageFixture> {
  const packageDir = resolve(join(params.rootDir, params.petId));
  const manifestPath = join(packageDir, 'pet.json');
  const spritesheetPath = join(packageDir, 'spritesheet.png');

  await mkdir(packageDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      id: params.petId,
      displayName: params.displayName ?? params.petId,
      description: 'Minimal transparent pet package for Happier e2e tests.',
      spritesheetPath: 'spritesheet.png',
    }),
    'utf8',
  );
  await writeFile(spritesheetPath, createMinimalPetSpritesheetPng());

  return { packageDir, manifestPath, spritesheetPath };
}

export function digestPetFixtureBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function readMinimalAccountPetCreatePayload(
  fixture: MinimalCodexPetPackageFixture,
  origin: AccountPetOriginV1 = { kind: 'manualImport' },
): Promise<AccountPetCreateRequestV1> {
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as unknown;
  const spritesheet = await readFile(fixture.spritesheetPath);
  const payload = {
    manifest,
    spritesheet: {
      mediaType: 'image/png',
      encoding: 'base64',
      data: spritesheet.toString('base64'),
      sizeBytes: spritesheet.byteLength,
      digest: digestPetFixtureBytes(spritesheet),
    },
    origin,
  };
  const parsed = AccountPetCreateRequestV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid minimal account pet create payload: ${parsed.error.message}`);
  }
  return parsed.data;
}
