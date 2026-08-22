import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { createNodeArchive, extractNodeArchive } from './node-archive.mjs';

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
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, entry.type ?? '0');
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

test('node archive owner creates and extracts one portable payload tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-'));
  try {
    const source = path.join(root, 'source');
    const payload = path.join(source, 'payload');
    const archive = path.join(root, 'payload.tar.gz');
    const extracted = path.join(root, 'extracted');
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, 'binary'), 'payload-bytes');

    await createNodeArchive({ sourcePath: source, sourceName: 'payload', artifactPath: archive });
    await extractNodeArchive({ archivePath: archive, extractDir: extracted });

    assert.equal(await readFile(path.join(extracted, 'payload', 'binary'), 'utf8'), 'payload-bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive extraction accepts first-party release payloads beyond generic entry limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-first-party-scale-'));
  try {
    const archive = path.join(root, 'payload.tar.gz');
    const extracted = path.join(root, 'extracted');
    const metadataEntryCount = 20_001;
    await writeFile(archive, createTarGzip([
      ...Array.from(
        { length: metadataEntryCount },
        (_, index) => ({
          name: `GlobalHead.${String(index).padStart(5, '0')}`,
          type: 'g',
          contents: '13 comment=x\n',
        }),
      ),
      { name: 'payload/file', contents: 'payload-bytes' },
    ]));

    await extractNodeArchive({ archivePath: archive, extractDir: extracted });

    assert.equal(await readFile(path.join(extracted, 'payload', 'file'), 'utf8'), 'payload-bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive creation omits links before extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-link-'));
  try {
    const source = path.join(root, 'source');
    const payload = path.join(source, 'payload');
    const archive = path.join(root, 'payload.tar.gz');
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, 'binary'), 'payload-bytes');
    await symlink('../../outside', path.join(payload, 'escape'));
    await createNodeArchive({ sourcePath: source, sourceName: 'payload', artifactPath: archive });

    const extracted = path.join(root, 'extracted');
    await extractNodeArchive({ archivePath: archive, extractDir: extracted });
    assert.equal(await readFile(path.join(extracted, 'payload', 'binary'), 'utf8'), 'payload-bytes');
    await assert.rejects(readFile(path.join(extracted, 'payload', 'escape')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive extraction rejects an archive that exceeds bounded entry limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-entry-limit-'));
  try {
    const source = path.join(root, 'source');
    const payload = path.join(source, 'payload');
    const archive = path.join(root, 'payload.tar.gz');
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, 'one'), 'one');
    await writeFile(path.join(payload, 'two'), 'two');
    await createNodeArchive({ sourcePath: source, sourceName: 'payload', artifactPath: archive });

    await assert.rejects(
      extractNodeArchive({
        archivePath: archive,
        extractDir: path.join(root, 'extracted'),
        limits: { maxEntries: 1 },
      }),
      /too many entries|entry limit exceeded/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive extraction binds validation to the bytes that are extracted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-substitution-'));
  const archive = path.join(root, 'payload.tar.gz');
  const replacementArchive = path.join(root, 'replacement.tar.gz');
  const validatedArchive = path.join(root, 'validated.tar.gz');
  const extracted = path.join(root, 'extracted');
  try {
    for (const [archivePath, contents] of [
      [archive, 'validated-bytes'],
      [replacementArchive, 'replacement-bytes'],
    ]) {
      const source = path.join(root, `source-${contents}`);
      await mkdir(path.join(source, 'payload'), { recursive: true });
      await writeFile(path.join(source, 'payload', 'binary'), contents);
      if (archivePath === archive) {
        await writeFile(path.join(source, 'payload', 'validation-padding'), Buffer.alloc(32 * 1024 * 1024));
      }
      await createNodeArchive({ sourcePath: source, sourceName: 'payload', artifactPath: archivePath });
    }

    const substitution = new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          renameSync(archive, validatedArchive);
          renameSync(replacementArchive, archive);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 10);
    });
    const extraction = extractNodeArchive({
      archivePath: archive,
      extractDir: extracted,
      limits: { maxCompressionRatio: 1_000_000 },
    });
    await substitution;
    await extraction;

    assert.equal(
      await readFile(path.join(extracted, 'payload', 'binary'), 'utf8'),
      'validated-bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive extraction failure preserves an empty final destination and removes partial staging output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-partial-'));
  try {
    const archive = path.join(root, 'payload.tar.gz');
    const extracted = path.join(root, 'extracted');
    await mkdir(extracted);
    await writeFile(archive, createTarGzip([
      { name: 'payload/', type: '5' },
      { name: 'payload/one', contents: 'one' },
      { name: 'payload/two', contents: 'two' },
    ]));

    await assert.rejects(
      extractNodeArchive({
        archivePath: archive,
        extractDir: extracted,
        limits: { maxExpandedBytes: 4 },
      }),
      /expanded[ -]byte limit/iu,
    );

    assert.deepEqual(await readdir(extracted), []);
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('.extracted.extract-')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node archive extraction rejects traversal, file-size, compression-ratio, and timeout violations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-limits-'));
  try {
    const traversalArchive = path.join(root, 'traversal.tar.gz');
    await writeFile(traversalArchive, createTarGzip([
      { name: 'payload/../outside', contents: 'escape' },
    ]));
    await assert.rejects(
      extractNodeArchive({ archivePath: traversalArchive, extractDir: path.join(root, 'traversal') }),
      /non-portable path/iu,
    );

    const boundedArchive = path.join(root, 'bounded.tar.gz');
    await writeFile(boundedArchive, createTarGzip([
      { name: 'payload/file', contents: '0123456789' },
    ]));
    await assert.rejects(
      extractNodeArchive({
        archivePath: boundedArchive,
        extractDir: path.join(root, 'file-size'),
        limits: { maxFileBytes: 9 },
      }),
      /file.*byte limit/iu,
    );
    await assert.rejects(
      extractNodeArchive({
        archivePath: boundedArchive,
        extractDir: path.join(root, 'ratio'),
        limits: { maxCompressionRatio: 0 },
      }),
      /expanded byte|compression ratio/iu,
    );
    await assert.rejects(
      extractNodeArchive({
        archivePath: boundedArchive,
        extractDir: path.join(root, 'timeout'),
        limits: { timeoutMs: 0 },
      }),
      /timed out/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
