import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

import * as tar from 'tar';

import {
  extractArchivePayloadToDirectory,
  inspectTarArchiveEntries,
} from '../dist/archiveExtraction.js';

function writeTarString(header, offset, length, value) {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length);
}

function writeTarOctal(header, offset, length, value) {
  writeTarString(header, offset, length, value.toString(8).padStart(length - 1, '0'));
}

function createTarGzip(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '', 'utf8');
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, entry.uid ?? 0);
    writeTarOctal(header, 116, 8, entry.gid ?? 0);
    writeTarOctal(header, 124, 12, entry.declaredSize ?? contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, entry.type ?? '0');
    writeTarString(header, 157, 100, entry.linkpath ?? '');
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, contents);
    if (contents.length % 512 !== 0) {
      blocks.push(Buffer.alloc(512 - (contents.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    if (entry.unixMode !== undefined) {
      centralHeader.writeUInt32LE((entry.unixMode << 16) >>> 0, 38);
    }
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name);
    localOffset += localHeader.length + name.length + contents.length;
  }

  const centralSize = centralRecords.reduce((size, record) => size + record.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, endRecord]);
}

function createDeflatedZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents, 'utf8');
    const compressedContents = deflateRawSync(contents);
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedContents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, compressedContents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedContents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressedContents.length;
  }

  const centralSize = centralRecords.reduce((size, record) => size + record.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, endRecord]);
}

test('extractArchivePayloadToDirectory extracts tar.gz without a system PATH', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-'));
  const payloadDir = join(rootDir, 'payload');
  const archivePath = join(rootDir, 'payload.tar.gz');
  const extractDir = join(rootDir, 'extract');
  const originalPath = process.env.PATH;

  try {
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, 'tool'), '#!/bin/sh\necho tool\n', 'utf8');
    await chmod(join(payloadDir, 'tool'), 0o755);
    await tar.c({ cwd: payloadDir, file: archivePath, gzip: true, portable: true }, ['tool']);
    process.env.PATH = '';

    await extractArchivePayloadToDirectory({
      archiveName: 'payload.tar.gz',
      archivePath,
      extractDir,
    });

    assert.match(await readFile(join(extractDir, 'tool'), 'utf8'), /echo tool/u);

    const tgzExtractDir = join(rootDir, 'extract-tgz');
    await extractArchivePayloadToDirectory({
      archiveName: 'payload.tgz',
      archivePath,
      extractDir: tgzExtractDir,
    });
    assert.match(await readFile(join(tgzExtractDir, 'tool'), 'utf8'), /echo tool/u);

    const rootEntryArchivePath = join(rootDir, 'root-entry.tar.gz');
    await tar.c({ cwd: payloadDir, file: rootEntryArchivePath, gzip: true, portable: true }, ['.']);
    const rootEntryExtractDir = join(rootDir, 'extract-root-entry');
    await extractArchivePayloadToDirectory({
      archiveName: 'root-entry.tar.gz',
      archivePath: rootEntryArchivePath,
      extractDir: rootEntryExtractDir,
    });
    assert.match(await readFile(join(rootEntryExtractDir, 'tool'), 'utf8'), /echo tool/u);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory never restores archive ownership under root extraction policy', async (t) => {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    t.skip('POSIX ownership semantics are unavailable');
    return;
  }

  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-owner-'));
  const archivePath = join(rootDir, 'payload.tar.gz');
  const extractDir = join(rootDir, 'extract');
  const actualUid = process.getuid();
  const actualGid = process.getgid();
  const archivedUid = actualUid + 10_000;
  const archivedGid = actualGid + 10_000;
  const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const getgidDescriptor = Object.getOwnPropertyDescriptor(process, 'getgid');

  try {
    await writeFile(archivePath, createTarGzip([
      {
        name: 'tool',
        contents: 'payload',
        uid: archivedUid,
        gid: archivedGid,
      },
    ]));
    Object.defineProperty(process, 'getuid', {
      configurable: true,
      value: () => 0,
    });
    Object.defineProperty(process, 'getgid', {
      configurable: true,
      value: () => 0,
    });

    await extractArchivePayloadToDirectory({
      archiveName: 'payload.tar.gz',
      archivePath,
      extractDir,
    });

    const extractedStats = await stat(join(extractDir, 'tool'));
    assert.equal(extractedStats.uid, actualUid);
    assert.equal(extractedStats.gid, actualGid);
  } finally {
    if (getuidDescriptor) Object.defineProperty(process, 'getuid', getuidDescriptor);
    if (getgidDescriptor) Object.defineProperty(process, 'getgid', getgidDescriptor);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory extracts Windows zip payloads in-process', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createStoredZip([
      { name: 'tool.exe', contents: 'zip-payload' },
      { name: 'dist/index.js', contents: 'zip-support' },
    ]));

    await extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir });

    assert.equal(await readFile(join(extractDir, 'tool.exe'), 'utf8'), 'zip-payload');
    assert.equal(await readFile(join(extractDir, 'dist', 'index.js'), 'utf8'), 'zip-support');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory extracts tar.xz payloads in-process', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-xz-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.xz');
    const extractDir = join(rootDir, 'extract');
    const archiveBase64 = '/Td6WFoAAATm1rRGBMBcgBAhARYAAAAAAAAAAJ0ecGrgB/8AVF0AOhvs2ADc/RSHzFwD/xdrNZax6wG7dSClR1LrXu8+D4zSKz623MdTYmPm7RMqTV2ysmEQwZ7t94mWdw8X1F2Mromk6pd2wgfJVO1buuSZeNa1XPsAAEcBzdZUqIflAAF4gBAAAAB8vNvFscRn+wIAAAAABFla';
    await writeFile(archivePath, Buffer.from(archiveBase64, 'base64'));

    await extractArchivePayloadToDirectory({ archiveName: 'payload.tar.xz', archivePath, extractDir });

    assert.equal(await readFile(join(extractDir, 'tool'), 'utf8'), 'xz-payload\n');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory keeps the default per-file ceiling at 256 MiB', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-default-file-budget-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.gz');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createTarGzip([
      {
        name: 'oversized-tool',
        declaredSize: (256 * 1024 * 1024) + 1,
      },
    ]));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.gz',
        archivePath,
        extractDir,
      }),
      /file exceeds its byte limit/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects gzip decompression bombs without publishing partial output', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-gzip-budget-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.gz');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createTarGzip([
      { name: 'safe.txt', contents: 'safe' },
      { name: 'bomb.bin', contents: '\0'.repeat(2 * 1024 * 1024) },
    ]));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.gz',
        archivePath,
        extractDir,
        limits: {
          maxCompressionRatio: 10,
          maxExpandedBytes: 4 * 1024 * 1024,
          maxFileBytes: 4 * 1024 * 1024,
        },
      }),
      /compression ratio/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory bounds tar.xz expansion outside node-tar decompression', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-xz-budget-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.xz');
    const extractDir = join(rootDir, 'extract');
    const archiveBase64 = '/Td6WFoAAATm1rRGBMBcgBAhARYAAAAAAAAAAJ0ecGrgB/8AVF0AOhvs2ADc/RSHzFwD/xdrNZax6wG7dSClR1LrXu8+D4zSKz623MdTYmPm7RMqTV2ysmEQwZ7t94mWdw8X1F2Mromk6pd2wgfJVO1buuSZeNa1XPsAAEcBzdZUqIflAAF4gBAAAAB8vNvFscRn+wIAAAAABFla';
    await writeFile(archivePath, Buffer.from(archiveBase64, 'base64'));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.xz',
        archivePath,
        extractDir,
        limits: { maxCompressionRatio: 1 },
      }),
      /compression ratio/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory bounds zip entry count and cumulative expanded bytes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-budget-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    await writeFile(archivePath, createStoredZip([
      { name: 'a.txt', contents: 'aaaa' },
      { name: 'b.txt', contents: 'bbbb' },
    ]));

    const archiveBytes = await readFile(archivePath);
    for (const [suffix, limits, pattern] of [
      ['archive-bytes', { maxArchiveBytes: archiveBytes.byteLength - 1 }, /compressed-byte limit/iu],
      ['entries', { maxEntries: 1 }, /too many entries/iu],
      ['files', { maxFiles: 1 }, /too many files/iu],
      ['file-bytes', { maxFileBytes: 3 }, /file exceeds its byte limit/iu],
      ['bytes', { maxExpandedBytes: 7 }, /expanded-byte limit/iu],
    ]) {
      const extractDir = join(rootDir, `extract-${suffix}`);
      if (suffix === 'bytes') await mkdir(extractDir, { recursive: true });
      await assert.rejects(
        extractArchivePayloadToDirectory({
          archiveName: 'payload.zip',
          archivePath,
          extractDir,
          limits,
        }),
        pattern,
      );
      if (suffix === 'bytes') {
        assert.deepEqual(await readdir(extractDir), []);
      } else {
        await assert.rejects(stat(extractDir), { code: 'ENOENT' });
      }
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects deflated zip decompression bombs without publishing partial output', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-ratio-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createDeflatedZip([
      { name: 'safe.txt', contents: 'safe' },
      { name: 'bomb.bin', contents: Buffer.alloc(2 * 1024 * 1024) },
    ]));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.zip',
        archivePath,
        extractDir,
        limits: {
          maxCompressionRatio: 10,
          maxExpandedBytes: 4 * 1024 * 1024,
          maxFileBytes: 4 * 1024 * 1024,
        },
      }),
      /compression ratio/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory restricts extraction to declared entry roots', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-entry-roots-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.gz');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createTarGzip([
      { name: 'node_modules/', type: '5' },
      { name: 'node_modules/sherpa-onnx-node/', type: '5' },
      { name: 'node_modules/sherpa-onnx-node/index.js', contents: 'module.exports = {};\n' },
      { name: 'node_modules/unexpected/index.js', contents: 'module.exports = {};\n' },
    ]));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.gz',
        archivePath,
        extractDir,
        allowedEntryRoots: ['node_modules/sherpa-onnx-node'],
      }),
      /allowed entry root/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory honors cancellation and timeout before publishing output', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-abort-'));
  try {
    const archivePath = join(rootDir, 'payload.tar.gz');
    await writeFile(archivePath, createTarGzip([{ name: 'tool', contents: 'payload' }]));
    const controller = new AbortController();
    controller.abort(new Error('caller stopped extraction'));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.gz',
        archivePath,
        extractDir: join(rootDir, 'extract-aborted'),
        signal: controller.signal,
      }),
      /aborted/iu,
    );
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.tar.gz',
        archivePath,
        extractDir: join(rootDir, 'extract-timeout'),
        limits: { timeoutMs: 0 },
      }),
      /timed out/iu,
    );
    await assert.rejects(stat(join(rootDir, 'extract-aborted')), { code: 'ENOENT' });
    await assert.rejects(stat(join(rootDir, 'extract-timeout')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects tar symlink smuggling outside the destination', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-symlink-'));
  const payloadDir = join(rootDir, 'payload');
  const outsideDir = join(rootDir, 'outside');
  const archivePath = join(rootDir, 'payload.tar.gz');
  const extractDir = join(rootDir, 'extract');
  try {
    await mkdir(payloadDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const outsideTargetPath = join(outsideDir, 'pwned.txt');
    await writeFile(outsideTargetPath, 'malicious', 'utf8');
    await symlink(outsideDir, join(payloadDir, 'escape'));
    await tar.c(
      { cwd: rootDir, file: archivePath, gzip: true, portable: true },
      ['payload/escape', 'payload/escape/pwned.txt'],
    );
    await writeFile(outsideTargetPath, 'original', 'utf8');

    await assert.rejects(
      extractArchivePayloadToDirectory({ archiveName: 'payload.tar.gz', archivePath, extractDir }),
      /symlink|symbolic|link/iu,
    );
    assert.equal(await readFile(outsideTargetPath, 'utf8'), 'original');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects standalone tar symlinks and hardlinks', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-links-'));
  const payloadDir = join(rootDir, 'payload');
  try {
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, 'target'), 'payload', 'utf8');
    await symlink('target', join(payloadDir, 'symlink'));
    const symlinkArchivePath = join(rootDir, 'symlink.tar.gz');
    await tar.c(
      { cwd: payloadDir, file: symlinkArchivePath, gzip: true, portable: true },
      ['symlink'],
    );
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'symlink.tar.gz',
        archivePath: symlinkArchivePath,
        extractDir: join(rootDir, 'extract-symlink'),
      }),
      /link/iu,
    );

    await link(join(payloadDir, 'target'), join(payloadDir, 'hardlink'));
    const hardlinkArchivePath = join(rootDir, 'hardlink.tar.gz');
    await tar.c(
      { cwd: payloadDir, file: hardlinkArchivePath, gzip: true, portable: true },
      ['target', 'hardlink'],
    );
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'hardlink.tar.gz',
        archivePath: hardlinkArchivePath,
        extractDir: join(rootDir, 'extract-hardlink'),
      }),
      /link/iu,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory can skip tar links for a verified runtime archive while retaining regular files', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-skip-links-'));
  const payloadDir = join(rootDir, 'payload');
  const archivePath = join(rootDir, 'payload.tar.gz');
  const extractDir = join(rootDir, 'extract');
  try {
    await mkdir(join(payloadDir, 'bin'), { recursive: true });
    await writeFile(join(payloadDir, 'bin', 'node'), 'runtime', 'utf8');
    await symlink('node', join(payloadDir, 'bin', 'corepack'));
    await tar.c(
      { cwd: rootDir, file: archivePath, gzip: true, portable: true },
      ['payload'],
    );

    await extractArchivePayloadToDirectory({
      archiveName: 'payload.tar.gz',
      archivePath,
      extractDir,
      tarLinkPolicy: 'skip',
    });

    assert.equal(await readFile(join(extractDir, 'payload', 'bin', 'node'), 'utf8'), 'runtime');
    await assert.rejects(
      readFile(join(extractDir, 'payload', 'bin', 'corepack'), 'utf8'),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects zip symlinks', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-link-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    await writeFile(archivePath, createStoredZip([
      { name: 'escape', contents: '../outside', unixMode: 0o120777 },
    ]));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.zip',
        archivePath,
        extractDir: join(rootDir, 'extract'),
      }),
      /link/iu,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects case-fold collisions and Windows-invalid paths', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-portable-path-'));
  try {
    const collisionArchivePath = join(rootDir, 'collision.zip');
    await writeFile(collisionArchivePath, createStoredZip([
      { name: 'Dist/tool', contents: 'first' },
      { name: 'dist/other', contents: 'second' },
    ]));
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'collision.zip',
        archivePath: collisionArchivePath,
        extractDir: join(rootDir, 'extract-collision'),
      }),
      /collision|duplicate/iu,
    );

    const invalidArchivePath = join(rootDir, 'invalid.zip');
    await writeFile(invalidArchivePath, createStoredZip([
      { name: 'dist/payload:stream', contents: 'ads' },
    ]));
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'invalid.zip',
        archivePath: invalidArchivePath,
        extractDir: join(rootDir, 'extract-invalid'),
      }),
      /invalid|portable|windows/iu,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects unknown archive formats', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-unknown-'));
  try {
    const archivePath = join(rootDir, 'payload.rar');
    await writeFile(archivePath, 'unsupported', 'utf8');
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.rar',
        archivePath,
        extractDir: join(rootDir, 'extract'),
      }),
      /unsupported archive type/iu,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('inspectTarArchiveEntries performs a complete non-extracting census through the canonical path validator', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-census-'));
  try {
    const archivePath = join(rootDir, 'payload.tgz');
    await writeFile(archivePath, createTarGzip([
      { name: 'package/', type: '5', mode: 0o755, uid: 101, gid: 202 },
      { name: 'package/./dist/index.js', contents: 'export {};\n', mode: 0o750, uid: 303, gid: 404 },
      { name: 'package/node_modules/dependency/cache.tsbuildinfo', contents: '{}' },
    ]));

    const entries = await inspectTarArchiveEntries({ archivePath });

    assert.deepEqual(entries, [
      { path: 'package', kind: 'directory', mode: 0o755, uid: 101, gid: 202 },
      { path: 'package/dist/index.js', kind: 'file', mode: 0o750, uid: 303, gid: 404 },
      {
        path: 'package/node_modules/dependency/cache.tsbuildinfo',
        kind: 'file',
        mode: 0o644,
        uid: 0,
        gid: 0,
      },
    ]);
    await assert.rejects(
      readFile(join(rootDir, 'package', 'dist', 'index.js')),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('inspectTarArchiveEntries rejects traversal, links, and special entries before extraction', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-census-reject-'));
  try {
    const cases = [
      { label: 'traversal', entries: [{ name: 'package/../outside', contents: 'escape' }], pattern: /non-portable path/iu },
      { label: 'symlink', entries: [{ name: 'package/link', type: '2', linkpath: '../outside' }], pattern: /link/iu },
      { label: 'hardlink', entries: [{ name: 'package/hardlink', type: '1', linkpath: 'package/target' }], pattern: /link/iu },
      { label: 'fifo', entries: [{ name: 'package/fifo', type: '6' }], pattern: /not supported/iu },
      {
        label: 'file-prefix',
        entries: [
          { name: 'package/a', contents: 'file' },
          { name: 'package/a/b', contents: 'child' },
        ],
        pattern: /prefix|file.*directory|directory.*file/iu,
      },
    ];
    for (const { label, entries, pattern } of cases) {
      const archivePath = join(rootDir, `${label}.tgz`);
      await writeFile(archivePath, createTarGzip(entries));
      await assert.rejects(inspectTarArchiveEntries({ archivePath }), pattern);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('inspectTarArchiveEntries applies the same entry and expanded-byte budgets as extraction', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-census-budget-'));
  try {
    const archivePath = join(rootDir, 'payload.tgz');
    await writeFile(archivePath, createTarGzip([
      { name: 'package/a.txt', contents: 'aaaa' },
      { name: 'package/b.txt', contents: 'bbbb' },
    ]));

    await assert.rejects(
      inspectTarArchiveEntries({ archivePath, limits: { maxEntries: 1 } }),
      /too many entries/iu,
    );
    await assert.rejects(
      inspectTarArchiveEntries({ archivePath, limits: { maxExpandedBytes: 7 } }),
      /expanded-byte limit/iu,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
