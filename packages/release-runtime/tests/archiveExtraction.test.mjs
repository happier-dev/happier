import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

import * as tar from 'tar';

import {
  extractArchivePayloadToDirectory,
  inspectTarArchiveEntries,
} from '../dist/archiveExtraction.js';

test('archive extraction keeps every format bound to one opened source handle', async () => {
  const source = await readFile(new URL('../src/archiveExtraction.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createReadStream\(params\.archivePath/);
  assert.doesNotMatch(source, /yauzl\.open\(\s*params\.archivePath/);
  assert.equal((source.match(/openArchiveSource\(/g) ?? []).length, 3);
});

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
    const name = entry.rawName ?? Buffer.from(entry.name, 'utf8');
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
    const name = entry.rawName ?? Buffer.from(entry.name, 'utf8');
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents, 'utf8');
    const fullCompressedContents = deflateRawSync(contents);
    const truncatedByteCount = entry.truncateCompressedBytes ?? 0;
    const compressedContents = Buffer.concat([
      fullCompressedContents.subarray(
        0,
        Math.max(0, fullCompressedContents.length - truncatedByteCount),
      ),
      Buffer.alloc(entry.trailingBytes ?? 0, 0xa5),
    ]);
    const declaredCompressedSize = entry.declaredCompressedSize
      ?? (truncatedByteCount === 0 ? compressedContents.length : fullCompressedContents.length);
    const checksum = crc32(contents);
    const generalPurposeBitFlag = (entry.dataDescriptor ? 0x8 : 0) | (entry.utf8Name ? 0x800 : 0);
    const localExtraField = entry.localExtraField ?? Buffer.alloc(0);
    const centralExtraField = entry.centralExtraField
      ?? (entry.zip64Descriptor ? Buffer.from([0x01, 0x00, 0x00, 0x00]) : Buffer.alloc(0));
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(entry.zip64Descriptor ? 45 : 20, 4);
    localHeader.writeUInt16LE(generalPurposeBitFlag, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : checksum, 14);
    localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : declaredCompressedSize, 18);
    localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(localExtraField.length, 28);
    let descriptor = Buffer.alloc(0);
    if (entry.dataDescriptor) {
      const includeSignature = entry.descriptorSignature !== false;
      const descriptorSizeBytes = entry.zip64Descriptor ? 8 : 4;
      descriptor = Buffer.alloc((includeSignature ? 4 : 0) + 4 + (2 * descriptorSizeBytes));
      let descriptorOffset = 0;
      if (includeSignature) {
        descriptor.writeUInt32LE(0x08074b50, descriptorOffset);
        descriptorOffset += 4;
      }
      descriptor.writeUInt32LE((entry.descriptorCrc32 ?? checksum) >>> 0, descriptorOffset);
      if (entry.zip64Descriptor) {
        descriptor.writeBigUInt64LE(
          BigInt(entry.descriptorCompressedSize ?? declaredCompressedSize),
          descriptorOffset + 4,
        );
        descriptor.writeBigUInt64LE(
          BigInt(entry.descriptorUncompressedSize ?? contents.length),
          descriptorOffset + 12,
        );
      } else {
        descriptor.writeUInt32LE(
          entry.descriptorCompressedSize ?? declaredCompressedSize,
          descriptorOffset + 4,
        );
        descriptor.writeUInt32LE(
          entry.descriptorUncompressedSize ?? contents.length,
          descriptorOffset + 8,
        );
      }
      if (entry.truncateDescriptorBytes) {
        descriptor = descriptor.subarray(
          0,
          Math.max(0, descriptor.length - entry.truncateDescriptorBytes),
        );
      }
    }
    localRecords.push(localHeader, name, localExtraField, compressedContents, descriptor);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(entry.zip64Descriptor ? 45 : 20, 6);
    centralHeader.writeUInt16LE(generalPurposeBitFlag, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(declaredCompressedSize, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(centralExtraField.length, 30);
    if (entry.unixMode !== undefined) {
      centralHeader.writeUInt32LE((entry.unixMode << 16) >>> 0, 38);
    }
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name, centralExtraField);
    localOffset += localHeader.length
      + name.length
      + localExtraField.length
      + compressedContents.length
      + descriptor.length;
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

function createUnicodePathExtra(rawName, unicodeName) {
  const encodedName = Buffer.from(unicodeName, 'utf8');
  const fieldData = Buffer.alloc(5 + encodedName.length);
  fieldData.writeUInt8(1, 0);
  fieldData.writeUInt32LE(crc32(Buffer.from(rawName, 'utf8')), 1);
  encodedName.copy(fieldData, 5);
  const field = Buffer.alloc(4 + fieldData.length);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(fieldData.length, 2);
  fieldData.copy(field, 4);
  return field;
}

function findZipRecordOffsets(archive, signature) {
  const offsets = [];
  for (let offset = 0; offset <= archive.length - 4; offset += 1) {
    if (archive.readUInt32LE(offset) === signature) offsets.push(offset);
  }
  return offsets;
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

test('extractArchivePayloadToDirectory extracts a durable multi-entry deflated ZIP', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-deflated-zip-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    let randomState = 0x6d2b79f5;
    const repeatedPayload = Buffer.alloc(96 * 1024);
    for (let index = 0; index < repeatedPayload.length; index += 1) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      repeatedPayload[index] = randomState & 0xff;
    }
    await writeFile(archivePath, createDeflatedZip([
      { name: 'codex.exe', contents: repeatedPayload },
      { name: 'codex-command-runner.exe', contents: 'runner' },
      { name: 'codex-windows-sandbox.exe', contents: 'sandbox' },
    ]));

    await extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir });

    assert.deepEqual(await readFile(join(extractDir, 'codex.exe')), repeatedPayload);
    assert.equal(await readFile(join(extractDir, 'codex-command-runner.exe'), 'utf8'), 'runner');
    assert.equal(await readFile(join(extractDir, 'codex-windows-sandbox.exe'), 'utf8'), 'sandbox');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory verifies ZIP payload checksums before publishing output', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-checksum-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    const archive = createStoredZip([
      { name: 'tool.exe', contents: 'zip-payload' },
    ]);
    const payloadOffset = archive.indexOf(Buffer.from('zip-payload', 'utf8'));
    assert.notEqual(payloadOffset, -1);
    archive[payloadOffset] ^= 0xff;
    await writeFile(archivePath, archive);

    await assert.rejects(
      extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
      /checksum/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects disagreement between ZIP central and local headers', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-header-consistency-'));
  try {
    const baseArchive = createStoredZip([
      { name: 'tool.exe', contents: 'zip-payload' },
    ]);
    const mutations = [
      ['name', (archive) => { archive[30] ^= 0x01; }],
      ['crc', (archive) => { archive.writeUInt32LE(archive.readUInt32LE(14) ^ 0x01, 14); }],
      ['compressed-size', (archive) => { archive.writeUInt32LE(archive.readUInt32LE(18) + 1, 18); }],
      ['uncompressed-size', (archive) => { archive.writeUInt32LE(archive.readUInt32LE(22) + 1, 22); }],
    ];

    for (const [suffix, mutate] of mutations) {
      const archive = Buffer.from(baseArchive);
      mutate(archive);
      const archivePath = join(rootDir, `${suffix}.zip`);
      const extractDir = join(rootDir, `extract-${suffix}`);
      await writeFile(archivePath, archive);
      await assert.rejects(
        extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
        /central and local headers disagree/iu,
      );
      await assert.rejects(stat(extractDir), { code: 'ENOENT' });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory requires central and local Unicode path semantics to agree', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-unicode-path-'));
  try {
    const rawName = 'tool.exe';
    const validArchivePath = join(rootDir, 'valid.zip');
    const validExtractDir = join(rootDir, 'extract-valid');
    const matchingExtra = createUnicodePathExtra(rawName, '工具.exe');
    await writeFile(validArchivePath, createDeflatedZip([
      {
        name: rawName,
        contents: 'zip-payload',
        localExtraField: matchingExtra,
        centralExtraField: matchingExtra,
      },
    ]));
    await extractArchivePayloadToDirectory({
      archiveName: 'valid.zip',
      archivePath: validArchivePath,
      extractDir: validExtractDir,
    });
    assert.equal(await readFile(join(validExtractDir, '工具.exe'), 'utf8'), 'zip-payload');

    const encodedNamesArchivePath = join(rootDir, 'encoded-names.zip');
    const encodedNamesExtractDir = join(rootDir, 'extract-encoded-names');
    await writeFile(encodedNamesArchivePath, createDeflatedZip([
      {
        name: 'unused-cp437-name',
        rawName: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]),
        contents: 'cp437',
      },
      {
        name: '原生.txt',
        contents: 'utf8',
        utf8Name: true,
      },
    ]));
    await extractArchivePayloadToDirectory({
      archiveName: 'encoded-names.zip',
      archivePath: encodedNamesArchivePath,
      extractDir: encodedNamesExtractDir,
    });
    assert.equal(await readFile(join(encodedNamesExtractDir, 'é.txt'), 'utf8'), 'cp437');
    assert.equal(await readFile(join(encodedNamesExtractDir, '原生.txt'), 'utf8'), 'utf8');

    const conflictingArchivePath = join(rootDir, 'conflicting.zip');
    const conflictingExtractDir = join(rootDir, 'extract-conflicting');
    await writeFile(conflictingArchivePath, createDeflatedZip([
      {
        name: rawName,
        contents: 'zip-payload',
        localExtraField: createUnicodePathExtra(rawName, '另一工具.exe'),
        centralExtraField: matchingExtra,
      },
    ]));
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'conflicting.zip',
        archivePath: conflictingArchivePath,
        extractDir: conflictingExtractDir,
      }),
      /Unicode path|central and local headers disagree/iu,
    );
    await assert.rejects(stat(conflictingExtractDir), { code: 'ENOENT' });

    for (const [suffix, localExtraField, centralExtraField] of [
      ['local-only', matchingExtra, Buffer.alloc(0)],
      ['central-only', Buffer.alloc(0), matchingExtra],
    ]) {
      const archivePath = join(rootDir, `${suffix}.zip`);
      const extractDir = join(rootDir, `extract-${suffix}`);
      await writeFile(archivePath, createDeflatedZip([
        {
          name: rawName,
          contents: 'zip-payload',
          localExtraField,
          centralExtraField,
        },
      ]));
      await assert.rejects(
        extractArchivePayloadToDirectory({
          archiveName: `${suffix}.zip`,
          archivePath,
          extractDir,
        }),
        /Unicode path fields disagree/iu,
      );
      await assert.rejects(stat(extractDir), { code: 'ENOENT' });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory does not let Unicode path extras rename bit-11 UTF-8 names', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-utf8-extra-'));
  try {
    const rawName = '原生.txt';
    const matchingExtra = createUnicodePathExtra(rawName, rawName);
    const validArchivePath = join(rootDir, 'valid.zip');
    const validExtractDir = join(rootDir, 'extract-valid');
    await writeFile(validArchivePath, createDeflatedZip([
      {
        name: rawName,
        contents: 'utf8-payload',
        utf8Name: true,
        localExtraField: matchingExtra,
        centralExtraField: matchingExtra,
      },
    ]));
    await extractArchivePayloadToDirectory({
      archiveName: 'valid.zip',
      archivePath: validArchivePath,
      extractDir: validExtractDir,
    });
    assert.equal(await readFile(join(validExtractDir, rawName), 'utf8'), 'utf8-payload');

    const renamedExtra = createUnicodePathExtra(rawName, '另一.txt');
    const renamedArchivePath = join(rootDir, 'renamed.zip');
    const renamedExtractDir = join(rootDir, 'extract-renamed');
    await writeFile(renamedArchivePath, createDeflatedZip([
      {
        name: rawName,
        contents: 'utf8-payload',
        utf8Name: true,
        localExtraField: renamedExtra,
        centralExtraField: renamedExtra,
      },
    ]));
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'renamed.zip',
        archivePath: renamedArchivePath,
        extractDir: renamedExtractDir,
      }),
      /Unicode path|UTF-8/iu,
    );
    await assert.rejects(stat(renamedExtractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory validates and accounts for ZIP data descriptors', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-descriptor-'));
  try {
    for (const [suffix, descriptorSignature, zip64Descriptor] of [
      ['signed', true, false],
      ['unsigned', false, false],
      ['zip64-signed', true, true],
      ['zip64-unsigned', false, true],
    ]) {
      const archivePath = join(rootDir, `${suffix}.zip`);
      const extractDir = join(rootDir, `extract-${suffix}`);
      await writeFile(archivePath, createDeflatedZip([
        {
          name: 'tool.exe',
          contents: 'zip-payload'.repeat(128),
          dataDescriptor: true,
          descriptorSignature,
          zip64Descriptor,
        },
        {
          name: 'runner.exe',
          contents: 'runner',
          dataDescriptor: true,
          descriptorSignature,
          zip64Descriptor,
        },
      ]));
      await extractArchivePayloadToDirectory({
        archiveName: `${suffix}.zip`,
        archivePath,
        extractDir,
      });
      assert.equal(await readFile(join(extractDir, 'tool.exe'), 'utf8'), 'zip-payload'.repeat(128));
      assert.equal(await readFile(join(extractDir, 'runner.exe'), 'utf8'), 'runner');
    }

    const invalidEntries = [
      ['missing', { truncateDescriptorBytes: 16 }],
      ['truncated', { truncateDescriptorBytes: 1 }],
      ['crc', { descriptorCrc32: 0x12345678 }],
      ['compressed-size', { descriptorCompressedSize: 1 }],
      ['uncompressed-size', { descriptorUncompressedSize: 1 }],
    ];
    for (const [suffix, descriptorMutation] of invalidEntries) {
      const archivePath = join(rootDir, `${suffix}.zip`);
      const extractDir = join(rootDir, `extract-${suffix}`);
      await writeFile(archivePath, createDeflatedZip([
        {
          name: 'tool.exe',
          contents: 'zip-payload'.repeat(128),
          dataDescriptor: true,
          ...descriptorMutation,
        },
      ]));
      await assert.rejects(
        extractArchivePayloadToDirectory({
          archiveName: `${suffix}.zip`,
          archivePath,
          extractDir,
        }),
        /data descriptor|central directory|overlap|ZIP/iu,
      );
      await assert.rejects(stat(extractDir), { code: 'ENOENT' });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects duplicate or central-directory ZIP payload ranges', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-ranges-'));
  try {
    const duplicateArchive = createStoredZip([
      { name: 'a.txt', contents: 'same' },
      { name: 'b.txt', contents: 'same' },
    ]);
    const centralOffsets = findZipRecordOffsets(duplicateArchive, 0x02014b50);
    assert.equal(centralOffsets.length, 2);
    duplicateArchive.writeUInt32LE(0, centralOffsets[1] + 42);
    const duplicateArchivePath = join(rootDir, 'duplicate.zip');
    const duplicateExtractDir = join(rootDir, 'extract-duplicate');
    await writeFile(duplicateArchivePath, duplicateArchive);
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'duplicate.zip',
        archivePath: duplicateArchivePath,
        extractDir: duplicateExtractDir,
      }),
      /central and local headers disagree|overlap/iu,
    );
    await assert.rejects(stat(duplicateExtractDir), { code: 'ENOENT' });

    const overlappingArchive = createStoredZip([
      { name: 'a.txt', contents: 'same' },
      { name: 'b.txt', contents: 'same' },
    ]);
    const overlappingCentralOffsets = findZipRecordOffsets(overlappingArchive, 0x02014b50);
    const firstExpandedPayload = overlappingArchive.subarray(35, 40);
    const firstExpandedChecksum = crc32(firstExpandedPayload);
    overlappingArchive.writeUInt32LE(firstExpandedChecksum, 14);
    overlappingArchive.writeUInt32LE(5, 18);
    overlappingArchive.writeUInt32LE(5, 22);
    overlappingArchive.writeUInt32LE(firstExpandedChecksum, overlappingCentralOffsets[0] + 16);
    overlappingArchive.writeUInt32LE(5, overlappingCentralOffsets[0] + 20);
    overlappingArchive.writeUInt32LE(5, overlappingCentralOffsets[0] + 24);
    const overlappingArchivePath = join(rootDir, 'overlap.zip');
    const overlappingExtractDir = join(rootDir, 'extract-overlap');
    await writeFile(overlappingArchivePath, overlappingArchive);
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'overlap.zip',
        archivePath: overlappingArchivePath,
        extractDir: overlappingExtractDir,
      }),
      /overlap/iu,
    );
    await assert.rejects(stat(overlappingExtractDir), { code: 'ENOENT' });

    const centralRangeArchive = createDeflatedZip([
      {
        name: 'tool.exe',
        contents: 'zip-payload',
        declaredCompressedSize: deflateRawSync(Buffer.from('zip-payload')).length + 1,
      },
    ]);
    const centralRangeArchivePath = join(rootDir, 'central-range.zip');
    const centralRangeExtractDir = join(rootDir, 'extract-central-range');
    await writeFile(centralRangeArchivePath, centralRangeArchive);
    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'central-range.zip',
        archivePath: centralRangeArchivePath,
        extractDir: centralRangeExtractDir,
      }),
      /central directory/iu,
    );
    await assert.rejects(stat(centralRangeExtractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects truncated and trailing deflate payloads', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-deflate-span-'));
  try {
    const archives = [
      ['truncated', createDeflatedZip([
        { name: 'tool.exe', contents: 'zip-payload'.repeat(128), truncateCompressedBytes: 1 },
      ])],
      ...[1, 16, 1024].map((trailingBytes) => [
        `trailing-${trailingBytes}`,
        createDeflatedZip([
          { name: 'tool.exe', contents: 'zip-payload'.repeat(128), trailingBytes },
        ]),
      ]),
    ];

    for (const [suffix, archive] of archives) {
      const archivePath = join(rootDir, `${suffix}.zip`);
      const extractDir = join(rootDir, `extract-${suffix}`);
      await writeFile(archivePath, archive);
      await assert.rejects(
        extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
        /ZIP|deflate|compressed|central directory|unexpected end/iu,
      );
      await assert.rejects(stat(extractDir), { code: 'ENOENT' });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects a deflated ZIP CRC mismatch before publishing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-deflate-crc-'));
  try {
    const archive = createDeflatedZip([
      { name: 'tool.exe', contents: 'zip-payload'.repeat(128) },
    ]);
    const centralOffsets = findZipRecordOffsets(archive, 0x02014b50);
    assert.equal(centralOffsets.length, 1);
    const incorrectChecksum = (archive.readUInt32LE(14) ^ 0x01) >>> 0;
    archive.writeUInt32LE(incorrectChecksum, 14);
    archive.writeUInt32LE(incorrectChecksum, centralOffsets[0] + 16);
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, archive);

    await assert.rejects(
      extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
      /checksum/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
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

test('extractArchivePayloadToDirectory closes ZIP census resources before reporting cancellation', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-abort-'));
  try {
    const archivePath = join(rootDir, 'payload.zip');
    const renamedArchivePath = join(rootDir, 'renamed.zip');
    const extractDir = join(rootDir, 'extract');
    await writeFile(archivePath, createStoredZip(
      Array.from({ length: 4000 }, (_, index) => ({
        name: `entries/${index.toString().padStart(4, '0')}.txt`,
        contents: 'payload',
      })),
    ));
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error('caller stopped ZIP extraction')));

    await assert.rejects(
      extractArchivePayloadToDirectory({
        archiveName: 'payload.zip',
        archivePath,
        extractDir,
        limits: { maxEntries: 5000 },
        signal: controller.signal,
      }),
      /aborted/iu,
    );
    await rename(archivePath, renamedArchivePath);
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
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

// A macOS `.app` framework bundle CANNOT be expressed without symlinks, so rejecting ZIP symlinks
// made the managed Chrome-for-Testing install impossible on macOS by any route (F-BROWSER-1).
//
// These names and targets are NOT invented: they are the five symlink entries read out of the
// central directory of the pinned artifact itself,
// https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/mac-arm64/chrome-mac-arm64.zip
// (313 entries: 146 directories, 162 files, 5 symlinks, 0 special files; every one madeBy=3 with
// unix file type 0o120000). Four of them resolve THROUGH `Versions/Current`, which is itself a
// symlink — so this fixture exercises chained resolution, not a single hop.
const CFT_FRAMEWORK_DIR = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework';
const CFT_PINNED_VERSION = '127.0.6533.88';
const CFT_BUNDLE_ENTRIES = [
  { name: `${CFT_FRAMEWORK_DIR}/Versions/${CFT_PINNED_VERSION}/Resources/version.txt`, contents: CFT_PINNED_VERSION },
  { name: `${CFT_FRAMEWORK_DIR}/Versions/Current`, contents: CFT_PINNED_VERSION, unixMode: 0o120755 },
  { name: `${CFT_FRAMEWORK_DIR}/Resources`, contents: 'Versions/Current/Resources', unixMode: 0o120755 },
  { name: `${CFT_FRAMEWORK_DIR}/Libraries`, contents: 'Versions/Current/Libraries', unixMode: 0o120755 },
  { name: `${CFT_FRAMEWORK_DIR}/Helpers`, contents: 'Versions/Current/Helpers', unixMode: 0o120755 },
  {
    name: `${CFT_FRAMEWORK_DIR}/Google Chrome for Testing Framework`,
    contents: 'Versions/Current/Google Chrome for Testing Framework',
    unixMode: 0o120755,
  },
];

test('extractArchivePayloadToDirectory extracts the pinned Chrome-for-Testing symlink graph', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-link-ok-'));
  const archivePath = join(rootDir, 'chrome-mac-arm64.zip');
  const extractDir = join(rootDir, 'extract');
  try {
    await writeFile(archivePath, createStoredZip(CFT_BUNDLE_ENTRIES));

    if (process.platform === 'win32') {
      // Documented platform contract: Windows symlink creation is privilege-gated, so the extractor
      // refuses loudly there rather than publishing a half-built bundle.
      await assert.rejects(
        extractArchivePayloadToDirectory({ archiveName: 'chrome-mac-arm64.zip', archivePath, extractDir }),
        /symlink/iu,
      );
      return;
    }

    await extractArchivePayloadToDirectory({ archiveName: 'chrome-mac-arm64.zip', archivePath, extractDir });

    const frameworkDir = join(extractDir, ...CFT_FRAMEWORK_DIR.split('/'));
    assert.equal((await lstat(join(frameworkDir, 'Versions', 'Current'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(frameworkDir, 'Versions', 'Current')), CFT_PINNED_VERSION);
    assert.equal(await readlink(join(frameworkDir, 'Resources')), 'Versions/Current/Resources');
    assert.equal(
      await readlink(join(frameworkDir, 'Google Chrome for Testing Framework')),
      'Versions/Current/Google Chrome for Testing Framework',
    );
    // Reading THROUGH both hops proves the bundle actually resolves, not merely that links exist.
    assert.equal(await readFile(join(frameworkDir, 'Resources', 'version.txt'), 'utf8'), CFT_PINNED_VERSION);
    // A target that points at a path the archive never declares is a legal dangling link, not an escape.
    assert.equal(await readlink(join(frameworkDir, 'Helpers')), 'Versions/Current/Helpers');

    // The shipped archive DEFLATES its entries, so the target must also survive inflate + CRC.
    const deflatedArchivePath = join(rootDir, 'deflated.zip');
    const deflatedExtractDir = join(rootDir, 'extract-deflated');
    await writeFile(deflatedArchivePath, createDeflatedZip(CFT_BUNDLE_ENTRIES));
    await extractArchivePayloadToDirectory({
      archiveName: 'deflated.zip',
      archivePath: deflatedArchivePath,
      extractDir: deflatedExtractDir,
    });
    assert.equal(
      await readFile(join(deflatedExtractDir, ...CFT_FRAMEWORK_DIR.split('/'), 'Resources', 'version.txt'), 'utf8'),
      CFT_PINNED_VERSION,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory rejects zip symlinks that leave the extraction root', async () => {
  const cases = [
    {
      label: 'absolute-posix-target',
      entries: [{ name: 'payload/link', contents: '/etc/passwd', unixMode: 0o120777 }],
    },
    {
      label: 'absolute-windows-target',
      entries: [{ name: 'payload/link', contents: 'C:/Windows/System32', unixMode: 0o120777 }],
    },
    {
      label: 'parent-traversal',
      entries: [{ name: 'escape', contents: '../outside', unixMode: 0o120777 }],
    },
    {
      label: 'deep-parent-traversal',
      entries: [{ name: 'payload/nested/link', contents: '../../../outside', unixMode: 0o120777 }],
    },
    {
      // Each link is contained when read on its own; only resolving `escape` THROUGH `hop`
      // reveals that it lands above the extraction root.
      label: 'chained-traversal',
      entries: [
        { name: 'a/b/hop', contents: '../..', unixMode: 0o120777 },
        { name: 'a/b/escape', contents: 'hop/../../outside', unixMode: 0o120777 },
      ],
    },
    {
      label: 'resolution-loop',
      entries: [
        { name: 'a/left', contents: 'right', unixMode: 0o120777 },
        { name: 'a/right', contents: 'left', unixMode: 0o120777 },
      ],
    },
    {
      label: 'backslash-target',
      entries: [{ name: 'payload/link', contents: '..\\outside', unixMode: 0o120777 }],
    },
    {
      label: 'empty-target',
      entries: [{ name: 'payload/link', contents: '', unixMode: 0o120777 }],
    },
  ];

  for (const testCase of cases) {
    const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-link-escape-'));
    const archivePath = join(rootDir, 'payload.zip');
    const extractDir = join(rootDir, 'extract');
    try {
      await writeFile(archivePath, createStoredZip(testCase.entries));
      await assert.rejects(
        extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
        /symlink/iu,
        testCase.label,
      );
      // Nothing may be published when any link in the archive is unsafe.
      await assert.rejects(stat(extractDir), { code: 'ENOENT' }, testCase.label);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('extractArchivePayloadToDirectory rejects a zip entry whose path descends through a symlink', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-link-traverse-'));
  const archivePath = join(rootDir, 'payload.zip');
  const extractDir = join(rootDir, 'extract');
  try {
    await writeFile(archivePath, createStoredZip([
      { name: 'a/link', contents: 'b', unixMode: 0o120777 },
      { name: 'a/link/planted', contents: 'pwned' },
    ]));
    await assert.rejects(
      extractArchivePayloadToDirectory({ archiveName: 'payload.zip', archivePath, extractDir }),
      /conflict|symlink/iu,
    );
    await assert.rejects(stat(extractDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('extractArchivePayloadToDirectory still rejects zip device, FIFO and socket entries', async () => {
  for (const [label, unixMode] of [
    ['character-device', 0o020666],
    ['block-device', 0o060666],
    ['fifo', 0o010666],
    ['socket', 0o140666],
  ]) {
    const rootDir = await mkdtemp(join(tmpdir(), 'release-runtime-extract-zip-special-'));
    const archivePath = join(rootDir, 'payload.zip');
    try {
      await writeFile(archivePath, createStoredZip([
        { name: 'payload/special', contents: '', unixMode },
      ]));
      await assert.rejects(
        extractArchivePayloadToDirectory({
          archiveName: 'payload.zip',
          archivePath,
          extractDir: join(rootDir, 'extract'),
        }),
        /special/iu,
        label,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
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
      { label: 'gnu-dump-dir', entries: [{ name: 'package', type: 'D', contents: 'unbudgeted metadata' }], pattern: /not supported/iu },
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
