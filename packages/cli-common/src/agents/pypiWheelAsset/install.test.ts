import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPypiWheelAsset } from './install.js';
import type { PypiWheelAssetSimpleIndex } from './resolve.js';

const tempDirs = new Set<string>();

const assetPathByPlatform = {
  'darwin-arm64': 'google/antigravity/bin/localharness',
} as const;

type ZipEntry = Readonly<{ name: string; data?: Buffer | string; mode?: number }>;

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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
    const name = Buffer.from(entry.name);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x031e), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function indexFor(bytes: Buffer, sha = sha256(bytes), size: number | null = bytes.length): PypiWheelAssetSimpleIndex {
  return {
    meta: { apiVersion: '1.3' },
    name: 'google-antigravity',
    files: [{
      filename: 'google_antigravity-0.1.5-py3-none-macosx_14_0_arm64.whl',
      url: 'https://files.pythonhosted.org/packages/google_antigravity-0.1.5-py3-none-macosx_14_0_arm64.whl',
      hashes: { sha256: sha },
      ...(size === null ? {} : { size }),
    }],
  };
}

async function createInstallRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-wheel-install-'));
  tempDirs.add(dir);
  return join(dir, 'tool');
}

describe('installPypiWheelAsset', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it('verifies the PyPI sha256 digest before extraction and fails without promotion on mismatch', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'candidate' }]);
    const installRoot = await createInstallRoot();

    await expect(installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      platform: 'darwin-arm64',
      index: indexFor(wheelBytes, '0'.repeat(64)),
      fetchWheel: vi.fn(async () => wheelBytes),
    })).rejects.toMatchObject({ code: 'wheel_digest_mismatch' });

    await expect(stat(join(installRoot, 'current'))).rejects.toThrow();
  });

  it('enforces maxWheelSizeBytes while reading the default download path when the index size is wrong', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'x'.repeat(64) }]);
    const chunks = [
      wheelBytes.subarray(0, 10),
      wheelBytes.subarray(10, 25),
      wheelBytes.subarray(25, 40),
      wheelBytes.subarray(40),
    ];
    let enqueuedChunks = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[enqueuedChunks];
        if (!next) {
          controller.close();
          return;
        }
        enqueuedChunks += 1;
        controller.enqueue(next);
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const installRoot = await createInstallRoot();

    await expect(installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      platform: 'darwin-arm64',
      maxWheelSizeBytes: 20,
      index: indexFor(wheelBytes, sha256(wheelBytes), 1),
    })).rejects.toMatchObject({ code: 'wheel_size_exceeded' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(enqueuedChunks).toBeLessThan(chunks.length);
  });

  it('preserves the size error when cancelling an oversized default download fails', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'x'.repeat(64) }]);
    const chunks = [
      wheelBytes.subarray(0, 12),
      wheelBytes.subarray(12, 32),
      wheelBytes.subarray(32),
    ];
    let enqueuedChunks = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[enqueuedChunks];
        if (!next) {
          controller.close();
          return;
        }
        enqueuedChunks += 1;
        controller.enqueue(next);
      },
      cancel() {
        throw new Error('cancel failed');
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const installRoot = await createInstallRoot();

    await expect(installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      platform: 'darwin-arm64',
      maxWheelSizeBytes: 20,
      index: indexFor(wheelBytes, sha256(wheelBytes), 1),
    })).rejects.toMatchObject({ code: 'wheel_size_exceeded' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('promotes a verified candidate and writes metadata after the compatibility probe passes', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'candidate' }]);
    const installRoot = await createInstallRoot();

    const result = await installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      compatibilityProbe: 'antigravity-localharness-v1',
      platform: 'darwin-arm64',
      index: indexFor(wheelBytes),
      fetchWheel: vi.fn(async () => wheelBytes),
      probeExecutable: vi.fn(async () => ({ ok: true })),
    });

    expect(result.executablePath.split(/[\\/]/)).toContain('versions');
    await expect(readFile(result.executablePath, 'utf8')).resolves.toBe('candidate');
    await expect(access(result.executablePath, fsConstants.X_OK)).resolves.toBeUndefined();
    await expect(readFile(result.metadataPath, 'utf8')).resolves.toContain('"distribution": "google-antigravity"');
    expect(result.metadataPath).toBe(join(installRoot, 'current.json'));
  });

  it('promotes through a versioned current pointer without replacing the previous current executable path', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'candidate' }]);
    const installRoot = await createInstallRoot();
    const previousPath = join(installRoot, 'current', 'bin', 'localharness');
    await mkdir(join(previousPath, '..'), { recursive: true });
    await writeFile(previousPath, 'previous');

    const result = await installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      compatibilityProbe: 'antigravity-localharness-v1',
      platform: 'darwin-arm64',
      index: indexFor(wheelBytes),
      fetchWheel: vi.fn(async () => wheelBytes),
      probeExecutable: vi.fn(async () => ({ ok: true })),
    });

    expect(result.executablePath).not.toBe(previousPath);
    expect(result.executablePath.split(/[\\/]/)).toContain('versions');
    await expect(readFile(previousPath, 'utf8')).resolves.toBe('previous');
    await expect(readFile(result.executablePath, 'utf8')).resolves.toBe('candidate');

    const current = JSON.parse(await readFile(join(installRoot, 'current.json'), 'utf8')) as { executablePath?: string; version?: string };
    expect(current).toEqual(expect.objectContaining({
      executablePath: result.executablePath,
      version: '0.1.5',
    }));
  });

  it('keeps the previous current executable when the compatibility probe rejects a candidate', async () => {
    const wheelBytes = createZip([{ name: 'google/antigravity/bin/localharness', data: 'candidate' }]);
    const installRoot = await createInstallRoot();
    const previousPath = join(installRoot, 'current', 'bin', 'localharness');
    await mkdir(join(previousPath, '..'), { recursive: true });
    await writeFile(previousPath, 'previous');

    await expect(installPypiWheelAsset({
      installRoot,
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      executable: true,
      compatibilityProbe: 'antigravity-localharness-v1',
      platform: 'darwin-arm64',
      index: indexFor(wheelBytes),
      fetchWheel: vi.fn(async () => wheelBytes),
      probeExecutable: vi.fn(async () => ({ ok: false, errorMessage: 'probe failed' })),
    })).rejects.toMatchObject({ code: 'compatibility_probe_failed' });

    await expect(readFile(previousPath, 'utf8')).resolves.toBe('previous');
  });
});
