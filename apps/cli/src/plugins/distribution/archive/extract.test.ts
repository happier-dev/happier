import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestNpmTarball, sriSha512, type TestTarEntry } from '../testkit/npmTarball';
import { cleanupExtractedPortableArchive, extractPortableTarGzipArchive } from './extract';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeArchive(entries: readonly TestTarEntry[]): Promise<Readonly<{ archivePath: string; bytes: Buffer; root: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-portable-archive-'));
  tempDirs.push(root);
  const bytes = await createTestNpmTarball(entries);
  const archivePath = join(root, 'candidate.tgz');
  await writeFile(archivePath, bytes);
  return { archivePath, bytes, root };
}

describe('extractPortableTarGzipArchive', () => {
  it('streams one verified archive into an operation-owned stage and returns a deterministic file inventory', async () => {
    const input = await writeArchive([
      { name: 'package/', type: 'directory' },
      { name: 'package/a.txt', body: 'alpha' },
      { name: 'package/nested/b.txt', body: 'beta' },
    ]);
    const stagingParentPath = join(input.root, 'staging');

    const first = await extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath,
      stripRootDirectory: 'package',
    });
    const second = await extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath,
      stripRootDirectory: 'package',
    });

    expect(first.inventory.map(({ path, byteLength }) => ({ path, byteLength }))).toEqual([
      { path: 'a.txt', byteLength: 5 },
      { path: 'nested/b.txt', byteLength: 4 },
    ]);
    expect(second.rootDigest).toBe(first.rootDigest);
    expect(await readFile(join(first.rootPath, 'nested/b.txt'), 'utf8')).toBe('beta');
    expect(first.rootPath).not.toBe(second.rootPath);
  });

  it.each([
    ['parent traversal', '../escape.txt'],
    ['root escape', 'package/../../escape.txt'],
    ['absolute POSIX', '/tmp/escape.txt'],
    ['absolute Windows', 'C:/escape.txt'],
    ['UNC', '//server/share/escape.txt'],
    ['backslash ambiguity', 'package\\escape.txt'],
    ['alternate data stream', 'package/file.txt:stream'],
    ['reserved Windows name', 'package/CON.txt'],
    ['reserved Windows clock device name', 'package/CLOCK$'],
    ['reserved Windows console input device name', 'package/CONIN$'],
    ['reserved Windows console output device name', 'package/CONOUT$'],
    ['reserved Windows superscript device name', 'package/COM¹.txt'],
    ['trailing dot', 'package/file.'],
    ['trailing space', 'package/file '],
    ['control character', 'package/bad\u0001.txt'],
    ['non-canonical Unicode', 'package/cafe\u0301.txt'],
  ])('rejects %s paths before publishing a stage', async (_case, path) => {
    const input = await writeArchive([{ name: path, body: 'unsafe' }]);
    const stagingParentPath = join(input.root, 'staging');

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath,
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_path_invalid' });

    await expect(readFile(input.archivePath)).resolves.toEqual(input.bytes);
  });

  it('bounds and escapes attacker-controlled archive paths in typed diagnostics', async () => {
    const input = await writeArchive([{ name: 'package/bad\nname.txt', body: 'unsafe' }]);

    const failure = await extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: 'archive_path_invalid' });
    expect((failure as Error).message).not.toContain('\n');
    expect((failure as Error).message.length).toBeLessThan(512);
  });

  it('rejects a PAX path with an overlong portable segment before filesystem extraction', async () => {
    const longPath = `package/${'a'.repeat(256)}`;
    const recordSuffix = ` path=${longPath}\n`;
    let recordLength = Buffer.byteLength(recordSuffix, 'utf8') + 1;
    while (Buffer.byteLength(`${recordLength}${recordSuffix}`, 'utf8') !== recordLength) {
      recordLength = Buffer.byteLength(`${recordLength}${recordSuffix}`, 'utf8');
    }
    const input = await writeArchive([
      { name: 'PaxHeader/file', type: 'extended-header', body: `${recordLength}${recordSuffix}` },
      { name: 'package/placeholder', body: 'unsafe' },
    ]);

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_path_invalid' });
  });

  it.each([
    ['symbolic link', { name: 'package/link', type: 'symlink', linkname: '../outside' }],
    ['hard link', { name: 'package/link', type: 'link', linkname: 'package/file' }],
    ['device', { name: 'package/device', type: 'character-device' }],
    ['fifo', { name: 'package/fifo', type: 'fifo' }],
  ] satisfies readonly [string, TestTarEntry][])('rejects unsupported %s entries', async (_case, entry) => {
    const input = await writeArchive([entry]);

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_entry_type_unsupported' });
  });

  it('rejects portable-path collisions and file/directory conflicts', async () => {
    for (const entries of [
      [{ name: 'package/Readme.md', body: 'a' }, { name: 'package/README.md', body: 'b' }],
      [{ name: 'package/a', body: 'file' }, { name: 'package/a/b', body: 'child' }],
      [{ name: 'package/a/b', body: 'child' }, { name: 'package/a', body: 'file' }],
    ] satisfies readonly (readonly TestTarEntry[])[]) {
      const input = await writeArchive(entries);
      await expect(extractPortableTarGzipArchive({
        archivePath: input.archivePath,
        expectedArchiveBytes: input.bytes.byteLength,
        expectedIntegrity: sriSha512(input.bytes),
        stagingParentPath: join(input.root, 'staging'),
        stripRootDirectory: 'package',
      })).rejects.toMatchObject({ code: 'archive_path_collision' });
    }
  });

  it('enforces entry, file, expanded-byte, path-depth, compression-ratio, and timeout limits', async () => {
    const input = await writeArchive([
      { name: 'package/a.txt', body: 'aaaaaaaaaa' },
      { name: 'package/deep/b.txt', body: 'bbbbbbbbbb' },
    ]);
    const cases = [
      { maxEntries: 1 },
      { maxFiles: 1 },
      { maxFileBytes: 9 },
      { maxExpandedBytes: 19 },
      { maxPathBytes: 9 },
      { maxPathDepth: 1 },
      { maxCompressionRatio: 0.01 },
      { timeoutMs: 0 },
    ];

    for (const limits of cases) {
      await expect(extractPortableTarGzipArchive({
        archivePath: input.archivePath,
        expectedArchiveBytes: input.bytes.byteLength,
        expectedIntegrity: sriSha512(input.bytes),
        stagingParentPath: join(input.root, 'staging'),
        stripRootDirectory: 'package',
        limits,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^archive_(limit|timeout)/) });
    }
  });

  it('accepts exact configured archive boundaries', async () => {
    const input = await writeArchive([
      { name: 'package/a.txt', body: 'aaaaaaaaaa' },
      { name: 'package/deep/b.txt', body: 'bbbbbbbbbb' },
    ]);

    const result = await extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
      limits: {
        maxEntries: 2,
        maxFiles: 2,
        maxFileBytes: 10,
        maxExpandedBytes: 20,
        maxPathBytes: 10,
        maxPathDepth: 2,
        maxCompressionRatio: 20 / input.bytes.byteLength,
      },
    });

    expect(result.inventory).toHaveLength(2);
  });

  it('counts extended metadata entries against entry and per-entry byte limits', async () => {
    const input = await writeArchive([
      { name: 'PaxHeader/a.txt', type: 'extended-header', body: '17 comment=value\n' },
      { name: 'package/a.txt', body: 'a' },
    ]);

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'entry-limit'),
      stripRootDirectory: 'package',
      limits: { maxEntries: 1 },
    })).rejects.toMatchObject({ code: 'archive_limit_entries' });

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'metadata-byte-limit'),
      stripRootDirectory: 'package',
      limits: { maxFileBytes: 16 },
    })).rejects.toMatchObject({ code: 'archive_limit_file_bytes' });
  });

  it('rejects a truncated gzip stream without hanging or publishing a partial stage', async () => {
    const input = await writeArchive([{ name: 'package/a.txt', body: 'alpha' }]);
    const truncated = input.bytes.subarray(0, input.bytes.byteLength - 8);
    await writeFile(input.archivePath, truncated);

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: truncated.byteLength,
      expectedIntegrity: sriSha512(truncated),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_format_invalid' });
  });

  it('cleans only its incomplete stage on integrity failure and preserves source and siblings', async () => {
    const input = await writeArchive([{ name: 'package/a.txt', body: 'alpha' }]);
    const stagingParentPath = join(input.root, 'staging');
    const siblingPath = join(stagingParentPath, 'owned-by-another-operation');
    await mkdir(stagingParentPath, { recursive: true });
    await writeFile(siblingPath, 'preserve', { flag: 'wx' });

    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(Buffer.from('other bytes')),
      stagingParentPath,
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_integrity_mismatch' });

    expect(await readFile(input.archivePath)).toEqual(input.bytes);
    expect(await readFile(siblingPath, 'utf8')).toBe('preserve');
  });

  it('joins concurrent cleanup callers for the same operation-owned extraction', async () => {
    const input = await writeArchive([{ name: 'package/a.txt', body: 'alpha' }]);
    const extracted = await extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'staging'),
      stripRootDirectory: 'package',
    });

    await expect(Promise.all([
      cleanupExtractedPortableArchive(extracted),
      cleanupExtractedPortableArchive(extracted),
    ])).resolves.toEqual([undefined, undefined]);
    await expect(readFile(join(extracted.rootPath, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
