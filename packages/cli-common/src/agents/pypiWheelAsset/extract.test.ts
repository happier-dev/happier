import { deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractExactWheelAsset } from './extract.js';

// Filesystem reads are the genuine OS boundary; other operations stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const tempDirs = new Set<string>();

type ZipEntry = Readonly<{
  name: string;
  data?: Buffer | string;
  mode?: number;
  compressionMethod?: number;
  reportedUncompressedSize?: number;
}>;

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed = compressionMethod === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(compressionMethod), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(entry.reportedUncompressedSize ?? data.length), u16(name.length), u16(0), name, compressed,
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x031e), u16(20), u16(0), u16(compressionMethod), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(entry.reportedUncompressedSize ?? data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(((entry.mode ?? 0o100644) << 16) >>> 0), u32(offset), name,
    ]));
    offset += local.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    centralDirectory,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.length), u32(centralOffset), u16(0),
  ]);
}

async function writeWheel(entries: readonly ZipEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-wheel-extract-'));
  tempDirs.add(dir);
  const wheelPath = join(dir, 'fixture.whl');
  await writeFile(wheelPath, createZip(entries));
  return wheelPath;
}

describe('extractExactWheelAsset', () => {
  afterEach(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it('treats a wheel as a zip archive and extracts only the exact configured member', async () => {
    const wheelPath = await writeWheel([
      { name: 'google/antigravity/bin/localharness', data: 'binary', compressionMethod: 8 },
      { name: 'google/antigravity/bin/other', data: 'do not extract' },
    ]);
    const outputDir = await mkdtemp(join(tmpdir(), 'happier-wheel-output-'));
    tempDirs.add(outputDir);
    const outputPath = join(outputDir, 'bin', 'localharness');

    await extractExactWheelAsset({
      wheelPath,
      assetPath: 'google/antigravity/bin/localharness',
      outputPath,
      maxAssetSizeBytes: 16,
    });

    await expect(readFile(outputPath, 'utf8')).resolves.toBe('binary');
    await expect(stat(join(outputPath, '..', 'other'))).rejects.toThrow();
  });

  it('cancels an in-flight extraction without publishing the executable', async () => {
    const wheelPath = await writeWheel([{ name: 'google/antigravity/bin/localharness', data: 'candidate', compressionMethod: 8 }]);
    const outputDir = await mkdtemp(join(tmpdir(), 'happier-wheel-output-'));
    tempDirs.add(outputDir);
    const outputPath = join(outputDir, 'localharness');
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const extraction = extractExactWheelAsset({
      wheelPath,
      assetPath: 'google/antigravity/bin/localharness',
      outputPath,
      maxAssetSizeBytes: 16,
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(extraction).rejects.toBe(reason);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a filesystem failure when cancellation arrives with the failed read', async () => {
    const wheelPath = await writeWheel([{ name: 'google/antigravity/bin/localharness', data: 'candidate' }]);
    const outputPath = join(wheelPath, '..', 'localharness');
    const controller = new AbortController();
    const readFailure = Object.assign(new Error('wheel read failed'), { code: 'ENOENT' });
    vi.mocked(readFile).mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled concurrently'));
      throw readFailure;
    });
    await expect(extractExactWheelAsset({
      wheelPath, outputPath, assetPath: 'google/antigravity/bin/localharness', maxAssetSizeBytes: 16, signal: controller.signal,
    })).rejects.toBe(readFailure);
    expect(controller.signal.aborted).toBe(true);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { reportedUncompressedSize: 1, actualSize: 32 },
    { reportedUncompressedSize: 8, actualSize: 16 },
  ])('bounds inflated bytes when metadata reports $reportedUncompressedSize and output is $actualSize', async ({ reportedUncompressedSize, actualSize }) => {
    const wheelPath = await writeWheel([
      {
        name: 'google/antigravity/bin/localharness',
        data: 'x'.repeat(actualSize),
        compressionMethod: 8,
        reportedUncompressedSize,
      },
    ]);
    const outputDir = await mkdtemp(join(tmpdir(), 'happier-wheel-output-'));
    tempDirs.add(outputDir);
    const outputPath = join(outputDir, 'bin', 'localharness');

    await expect(extractExactWheelAsset({
      wheelPath,
      assetPath: 'google/antigravity/bin/localharness',
      outputPath,
      maxAssetSizeBytes: 8,
    })).rejects.toMatchObject({ code: 'wheel_asset_oversize' });

    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['traversal', '../localharness', 'wheel_asset_traversal'],
    ['absolute path', '/google/antigravity/bin/localharness', 'wheel_asset_absolute_path'],
    ['directory member', 'google/antigravity/bin/localharness/', 'wheel_asset_directory'],
    ['symlink member', 'google/antigravity/bin/localharness', 'wheel_asset_symlink', 0o120777],
  ] satisfies Array<[string, string, string, number?]>)('rejects a %s payload member', async (_label, name, code, mode?: number) => {
    const wheelPath = await writeWheel([{ name, data: 'binary', ...(mode ? { mode } : {}) }]);
    await expect(extractExactWheelAsset({
      wheelPath,
      assetPath: name,
      outputPath: join(await mkdtemp(join(tmpdir(), 'happier-wheel-output-')), 'localharness'),
      maxAssetSizeBytes: 16,
    })).rejects.toMatchObject({ code });
  });

  it('rejects duplicate exact members and oversize payloads', async () => {
    const duplicateWheel = await writeWheel([
      { name: 'google/antigravity/bin/localharness', data: 'one' },
      { name: 'google/antigravity/bin/localharness', data: 'two' },
    ]);
    await expect(extractExactWheelAsset({
      wheelPath: duplicateWheel,
      assetPath: 'google/antigravity/bin/localharness',
      outputPath: join(await mkdtemp(join(tmpdir(), 'happier-wheel-output-')), 'localharness'),
      maxAssetSizeBytes: 16,
    })).rejects.toMatchObject({ code: 'wheel_asset_duplicate_member' });

    const oversizeWheel = await writeWheel([{ name: 'google/antigravity/bin/localharness', data: 'too large' }]);
    await expect(extractExactWheelAsset({
      wheelPath: oversizeWheel,
      assetPath: 'google/antigravity/bin/localharness',
      outputPath: join(await mkdtemp(join(tmpdir(), 'happier-wheel-output-')), 'localharness'),
      maxAssetSizeBytes: 3,
    })).rejects.toMatchObject({ code: 'wheel_asset_oversize' });
  });
});
