import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractReleaseArchiveIntoCache } from './archiveCache.mjs';

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

test('extractReleaseArchiveIntoCache removes partial cache output after extraction failure', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'relay-server-archive-cache-'));
  const archivePath = join(rootDir, 'payload.zip');
  const cacheDir = join(rootDir, 'cache');
  try {
    await writeFile(archivePath, createStoredZip([
      { name: 'happier-server/happier-server', contents: 'partial-binary' },
      { name: 'escape', contents: '../outside', unixMode: 0o120777 },
    ]));

    await assert.rejects(
      extractReleaseArchiveIntoCache({ archiveName: 'payload.zip', archivePath, cacheDir }),
      /link|special/iu,
    );
    await assert.rejects(stat(cacheDir), { code: 'ENOENT' });
    await assert.rejects(readFile(join(cacheDir, 'happier-server', 'happier-server'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
