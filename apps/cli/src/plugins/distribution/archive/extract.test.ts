import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { c as createTar } from 'tar';

import { createTestNpmTarball, sriSha512, type TestTarEntry } from '../testkit/npmTarball';
import { cleanupExtractedPortableArchive, extractPortableTarGzipArchive } from './extract';

// Filesystem boundary only: extraction and tar validation remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(filesystem.open).mockRestore();
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
  it('backpressures empty-file writes through their filesystem settlement instead of exhausting descriptors', async () => {
    const input = await writeArchive(Array.from({ length: 3 }, (_, index) => ({ name: `package/${index}.txt`, body: '' })));
    const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let activeDestinationFiles = 0;
    vi.mocked(filesystem.open).mockImplementation(async (...args) => {
      if (!String(args[0]).endsWith('.txt')) return await realOpen(...args);
      // OS descriptor availability is a real boundary. Empty tar entries may
      // finish parsing before the filesystem has completed opening their file.
      if (activeDestinationFiles !== 0) throw Object.assign(new Error('Too many open files'), { code: 'EMFILE' });
      activeDestinationFiles += 1;
      const file = await realOpen(...args);
      const close = file.close.bind(file);
      let closing: Promise<void> | undefined;
      file.close = () => closing ??= (async () => {
        // A slow filesystem close still owns the descriptor after tar has
        // emitted the empty entry's end. Keep that real boundary in scope.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await close();
        activeDestinationFiles -= 1;
      })();
      return file;
    });
    const archive = await extractPortableTarGzipArchive({
      archivePath: input.archivePath, expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes), stagingParentPath: join(input.root, 'staging'), stripRootDirectory: 'package',
    });
    expect(archive.inventory.map((file) => file.path)).toEqual(['0.txt', '1.txt', '2.txt']);
    expect(activeDestinationFiles).toBe(0);
    await cleanupExtractedPortableArchive(archive);
  });

  it.skipIf(process.platform === 'win32')('preserves executable file and directory permissions at the filesystem boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-portable-mode-'));
    tempDirs.push(root);
    await mkdir(join(root, 'package/bin'), { recursive: true });
    await writeFile(join(root, 'package/bin/run'), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, 'package/bin'), 0o700);
    await chmod(join(root, 'package/bin/run'), 0o750);
    const archivePath = join(root, 'candidate.tgz');
    await createTar({ gzip: true, cwd: root, file: archivePath }, ['package/bin']);
    const bytes = await readFile(archivePath);
    const archive = await extractPortableTarGzipArchive({
      archivePath, expectedArchiveBytes: bytes.byteLength, expectedIntegrity: sriSha512(bytes),
      stagingParentPath: join(root, 'staging'), stripRootDirectory: 'package',
    });
    expect((await stat(join(archive.rootPath, 'bin'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(archive.rootPath, 'bin/run'))).mode & 0o777).toBe(0o750 & ~process.umask());
    await cleanupExtractedPortableArchive(archive);
  });

  it('joins started writes before reporting an explicit inventory limit and removes only its stage', async () => {
    const input = await writeArchive(Array.from({ length: 4_097 }, (_, index) => ({ name: `package/${index}.txt`, body: '' })));
    const stagingParentPath = join(input.root, 'staging');
    await mkdir(stagingParentPath);
    await writeFile(join(stagingParentPath, 'sibling.txt'), 'preserve');
    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath, expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes), stagingParentPath, stripRootDirectory: 'package',
      limits: { maxFiles: 2_048, maxEntries: 4_097 },
    })).rejects.toMatchObject({ code: 'archive_limit_files' });
    expect(await readdir(stagingParentPath)).toEqual(['sibling.txt']);
    expect(await readFile(input.archivePath)).toEqual(input.bytes);
  });
  it.each([
    ['file bytes', {}],
    ['expanded bytes', { maxFileBytes: 257 * 1024 * 1024 }],
    ['compression ratio', { maxFileBytes: 257 * 1024 * 1024, maxExpandedBytes: 257 * 1024 * 1024 }],
  ])('streams a valid sparse archive beyond the former implicit %s ceiling', async (_label, limits) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-portable-streaming-'));
    tempDirs.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(join(root, 'package/large.bin'), '');
    const expandedBytes = 257 * 1024 * 1024;
    await truncate(join(root, 'package/large.bin'), expandedBytes);
    const archivePath = join(root, 'candidate.tgz');
    await createTar({ gzip: true, cwd: root, file: archivePath }, ['package/large.bin']);
    const bytes = await readFile(archivePath);
    const archive = await extractPortableTarGzipArchive({
      archivePath, expectedArchiveBytes: bytes.byteLength, expectedIntegrity: sriSha512(bytes),
      stagingParentPath: join(root, 'staging'), stripRootDirectory: 'package', limits,
    });
    expect(archive.inventory).toEqual([{ path: 'large.bin', byteLength: expandedBytes, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }]);
    expect((await stat(join(archive.rootPath, 'large.bin'))).size).toBe(expandedBytes);
    await cleanupExtractedPortableArchive(archive);
  });

  it.each([
    ['files', { maxEntries: 4_097 }],
    ['entries', { maxFiles: 4_097 }],
  ])('extracts a valid inventory beyond the former implicit %s ceiling', async (_label, limits) => {
    const input = await writeArchive(Array.from({ length: 4_097 }, (_, index) => ({ name: `package/${index}.txt`, body: '' })));
    const archive = await extractPortableTarGzipArchive({
      archivePath: input.archivePath, expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes), stagingParentPath: join(input.root, 'staging'), stripRootDirectory: 'package', limits,
    });
    expect(archive.inventory).toHaveLength(4_097);
    expect(await readFile(join(archive.rootPath, '4096.txt'), 'utf8')).toBe('');
    await cleanupExtractedPortableArchive(archive);
  });

  it('extracts a portable path beyond the former implicit total-byte and depth ceilings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-portable-deep-'));
    tempDirs.push(root);
    const relativeDirectory = Array.from({ length: 34 }, () => 'x'.repeat(31)).join('/');
    await mkdir(join(root, 'package', relativeDirectory), { recursive: true });
    await writeFile(join(root, 'package', relativeDirectory, 'a.txt'), 'alpha');
    const archivePath = join(root, 'candidate.tgz');
    await createTar({ gzip: true, cwd: root, file: archivePath }, [`package/${relativeDirectory}/a.txt`]);
    const bytes = await readFile(archivePath);
    const archive = await extractPortableTarGzipArchive({
      archivePath, expectedArchiveBytes: bytes.byteLength, expectedIntegrity: sriSha512(bytes),
      stagingParentPath: join(root, 'staging'), stripRootDirectory: 'package',
    });
    expect(await readFile(join(archive.rootPath, relativeDirectory, 'a.txt'), 'utf8')).toBe('alpha');
    await cleanupExtractedPortableArchive(archive);
  });

  it('finishes extraction when the filesystem settles after the former deadline', async () => {
    const input = await writeArchive([{ name: 'package/a.txt', body: 'alpha' }]);
    const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void;
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => { opened = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(filesystem.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('a.txt')) {
        opened();
        await pending;
      }
      return await realOpen(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const operation = extractPortableTarGzipArchive({
      archivePath: input.archivePath, expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes), stagingParentPath: join(input.root, 'staging'), stripRootDirectory: 'package',
    });
    await opening;
    await vi.advanceTimersByTimeAsync(30_001);
    release();
    const archive = await operation;
    await expect(readFile(join(archive.rootPath, 'a.txt'), 'utf8')).resolves.toBe('alpha');
    await cleanupExtractedPortableArchive(archive);
  });

  it('retires a cancelled extraction after pending filesystem work settles and preserves siblings', async () => {
    const input = await writeArchive([{ name: 'package/a.txt', body: 'alpha' }]);
    const stagingParentPath = join(input.root, 'staging');
    await mkdir(stagingParentPath);
    await writeFile(join(stagingParentPath, 'sibling.txt'), 'preserve');
    const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void;
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => { opened = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(filesystem.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('a.txt')) {
        opened();
        await pending;
      }
      return await realOpen(...args);
    });
    const controller = new AbortController();
    const operation = extractPortableTarGzipArchive({
      archivePath: input.archivePath, expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes), stagingParentPath, stripRootDirectory: 'package',
      signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'archive_aborted' });
    await opening;
    controller.abort(new Error('install cancelled'));
    release();
    await rejected;
    expect(await readdir(stagingParentPath)).toEqual(['sibling.txt']);
    expect(await readFile(input.archivePath)).toEqual(input.bytes);
    expect(await readFile(join(stagingParentPath, 'sibling.txt'), 'utf8')).toBe('preserve');
  });

  it('streams one verified archive into an operation-owned stage with a deterministic per-file inventory but no aggregate root digest', async () => {
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

    expect(first.inventory).toEqual([
      { path: 'a.txt', byteLength: 5, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
      { path: 'nested/b.txt', byteLength: 4, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    ]);
    expect(second.inventory).toEqual(first.inventory);
    expect(first).not.toHaveProperty('rootDigest');
    expect(second).not.toHaveProperty('rootDigest');
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

  it('enforces explicit entry, file, expanded-byte, path-depth, and compression-ratio limits', async () => {
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
    ];

    for (const limits of cases) {
      await expect(extractPortableTarGzipArchive({
        archivePath: input.archivePath,
        expectedArchiveBytes: input.bytes.byteLength,
        expectedIntegrity: sriSha512(input.bytes),
        stagingParentPath: join(input.root, 'staging'),
        stripRootDirectory: 'package',
        limits,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^archive_limit/) });
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

  it('retains the tar parser buffered PAX metadata limit', async () => {
    const input = await writeArchive([
      { name: 'PaxHeader/a.txt', type: 'extended-header', body: 'x'.repeat(1024 * 1024 + 1) },
      { name: 'package/a.txt', body: 'a' },
    ]);
    await expect(extractPortableTarGzipArchive({
      archivePath: input.archivePath,
      expectedArchiveBytes: input.bytes.byteLength,
      expectedIntegrity: sriSha512(input.bytes),
      stagingParentPath: join(input.root, 'pax-buffer-limit'),
      stripRootDirectory: 'package',
    })).rejects.toMatchObject({ code: 'archive_format_invalid' });
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
