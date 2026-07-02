import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createRequire } from 'node:module';

import archiver from 'archiver';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type ToolArchiveManifestEntry = Readonly<{
  tool: string;
  platformDir: string;
  archiveName: string;
  archiveType: 'tar.gz' | 'zip';
  binaryName: string;
  version: string;
  licenseName?: string;
  extraBinaries?: readonly string[];
}>;

type UnpackToolsModule = Readonly<{
  getPlatformDir: () => string;
  getToolsDir: () => string;
  getToolArchiveManifest: () => readonly ToolArchiveManifestEntry[];
  areToolsUnpacked: (toolsDir: string, platformDir?: string) => boolean;
  unpackArchive: (archivePath: string, destDir: string) => Promise<void>;
  unpackTools: (options?: { platformDir?: string; toolsDir?: string }) => Promise<{ success: boolean; alreadyUnpacked: boolean }>;
  readChecksumManifest: (manifestPath: string) => Map<string, string>;
  verifyArchiveChecksum: (archivePath: string, manifestPath?: string) => void;
}>;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function createTarGz(sourceDir: string, archivePath: string, entries: readonly string[]): Promise<void> {
  const tarPath = `${archivePath}.tar`;
  await tar.create({ cwd: sourceDir, file: tarPath }, [...entries]);
  await pipeline(createReadStream(tarPath), createGzip(), createWriteStream(archivePath));
}

async function createZip(sourceDir: string, archivePath: string, entries: readonly string[]): Promise<void> {
  const archive = archiver('zip');
  const output = createWriteStream(archivePath);
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    archive.file(join(sourceDir, entry), { name: entry });
  }
  await archive.finalize();
  await done;
}

async function writeManifestChecksums(archivesDir: string, checksums: Record<string, string>): Promise<void> {
  await writeFile(join(archivesDir, 'checksums.sha256'), Object.entries(checksums).map(([name, sum]) => `${sum}  ${name}`).join('\n'));
}

describe('unpack-tools script', () => {
  it('manifest includes explicit zellij archive mappings including Windows zip', () => {
    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    expect(unpackTools.getToolArchiveManifest()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'zellij',
          platformDir: 'x64-win32',
          archiveName: 'zellij-no-web-x86_64-pc-windows-msvc.zip',
          archiveType: 'zip',
          binaryName: 'zellij.exe',
          licenseName: 'zellij-LICENSE',
          version: '0.44.3',
        }),
        expect.objectContaining({
          tool: 'zellij',
          platformDir: 'arm64-darwin',
          archiveName: 'zellij-no-web-aarch64-apple-darwin.tar.gz',
          archiveType: 'tar.gz',
          binaryName: 'zellij',
          licenseName: 'zellij-LICENSE',
          version: '0.44.3',
        }),
      ]),
    );
  });

  it('does not treat rg and difftastic alone as fully unpacked for zellij platforms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const unpacked = join(root, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, 'rg'), 'rg');
    await writeFile(join(unpacked, 'ripgrep.node'), 'node');
    await writeFile(join(unpacked, 'difft'), 'difft');

    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    expect(unpackTools.areToolsUnpacked(root, 'x64-linux')).toBe(false);
  });

  it('uses the requested platform when checking whether tools are already unpacked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const unpacked = join(root, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, 'difft.exe'), 'difft');
    await writeFile(join(unpacked, 'rg.exe'), 'rg');
    await writeFile(join(unpacked, 'ripgrep.node'), 'node');
    await writeFile(join(unpacked, 'zellij.exe'), 'zellij');
    await writeFile(join(unpacked, 'difftastic-LICENSE'), 'difft license');
    await writeFile(join(unpacked, 'ripgrep-LICENSE'), 'rg license');
    await writeFile(join(unpacked, 'zellij-LICENSE'), 'zellij license');
    await writeFile(join(unpacked, '.happier-tools-manifest.json'), `${JSON.stringify({
      platformDir: 'x64-win32',
      tools: {
        difftastic: {
          version: '0',
          archiveName: 'difftastic-x64-win32.tar.gz',
        },
        ripgrep: {
          version: '0',
          archiveName: 'ripgrep-x64-win32.tar.gz',
        },
        zellij: {
          version: '0.44.3',
          archiveName: 'zellij-no-web-x86_64-pc-windows-msvc.zip',
        },
      },
    }, null, 2)}\n`);

    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).resolves.toEqual({
      success: true,
      alreadyUnpacked: true,
    });
  });

  it('extracts tar.gz and zip archives, verifies checksums, copies licenses, and writes version markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const archives = join(root, 'archives');
    const staging = join(root, 'staging');
    await mkdir(archives, { recursive: true });
    await mkdir(staging, { recursive: true });

    await writeFile(join(staging, 'difft.exe'), 'difft');
    await writeFile(join(staging, 'rg.exe'), 'rg');
    await writeFile(join(staging, 'ripgrep.node'), 'node');
    await writeFile(join(staging, 'zellij.exe'), 'zellij');
    await writeFile(join(archives, 'difftastic-LICENSE'), 'difft license');
    await writeFile(join(archives, 'ripgrep-LICENSE'), 'rg license');
    await writeFile(join(archives, 'zellij-LICENSE'), 'zellij license');

    const difftArchive = join(archives, 'difftastic-x64-win32.tar.gz');
    const rgArchive = join(archives, 'ripgrep-x64-win32.tar.gz');
    const zellijArchive = join(archives, 'zellij-no-web-x86_64-pc-windows-msvc.zip');
    await createTarGz(staging, difftArchive, ['difft.exe']);
    await createTarGz(staging, rgArchive, ['rg.exe', 'ripgrep.node']);
    await createZip(staging, zellijArchive, ['zellij.exe']);
    await writeManifestChecksums(archives, {
      'difftastic-x64-win32.tar.gz': await sha256(difftArchive),
      'ripgrep-x64-win32.tar.gz': await sha256(rgArchive),
      'zellij-no-web-x86_64-pc-windows-msvc.zip': await sha256(zellijArchive),
    });

    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).resolves.toEqual({
      success: true,
      alreadyUnpacked: false,
    });

    await expect(readFile(join(root, 'unpacked', 'zellij.exe'), 'utf8')).resolves.toBe('zellij');
    await expect(readFile(join(root, 'unpacked', 'zellij-LICENSE'), 'utf8')).resolves.toBe('zellij license');
    await expect(readFile(join(root, 'unpacked', '.happier-tools-manifest.json'), 'utf8')).resolves.toContain('"zellij"');
    await expect(stat(join(root, 'unpacked', 'zellij.exe'))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('fails closed on checksum mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const archives = join(root, 'archives');
    const staging = join(root, 'staging');
    await mkdir(archives, { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'difft'), 'difft');
    await writeFile(join(archives, 'difftastic-LICENSE'), 'difft license');
    const difftArchive = join(archives, 'difftastic-x64-linux.tar.gz');
    await createTarGz(staging, difftArchive, ['difft']);
    await writeManifestChecksums(archives, { 'difftastic-x64-linux.tar.gz': '0'.repeat(64) });

    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-linux', toolsDir: root })).rejects.toThrow(/checksum/i);
  });

  it('fails closed when a manifest archive has no checksum entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const archives = join(root, 'archives');
    const staging = join(root, 'staging');
    await mkdir(archives, { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'difft.exe'), 'difft');
    await writeFile(join(staging, 'rg.exe'), 'rg');
    await writeFile(join(staging, 'ripgrep.node'), 'node');
    await writeFile(join(staging, 'zellij.exe'), 'zellij');
    await writeFile(join(archives, 'difftastic-LICENSE'), 'difft license');
    await writeFile(join(archives, 'ripgrep-LICENSE'), 'rg license');
    await writeFile(join(archives, 'zellij-LICENSE'), 'zellij license');

    const difftArchive = join(archives, 'difftastic-x64-win32.tar.gz');
    const rgArchive = join(archives, 'ripgrep-x64-win32.tar.gz');
    const zellijArchive = join(archives, 'zellij-no-web-x86_64-pc-windows-msvc.zip');
    await createTarGz(staging, difftArchive, ['difft.exe']);
    await createTarGz(staging, rgArchive, ['rg.exe', 'ripgrep.node']);
    await createZip(staging, zellijArchive, ['zellij.exe']);
    await writeManifestChecksums(archives, {
      'difftastic-x64-win32.tar.gz': await sha256(difftArchive),
      'zellij-no-web-x86_64-pc-windows-msvc.zip': await sha256(zellijArchive),
    });

    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).rejects.toThrow(/missing checksum/i);
  });

  it('shipped checksum file covers every manifest archive and matches archive bytes', async () => {
    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    const archivesDir = join(unpackTools.getToolsDir(), 'archives');
    const manifest = unpackTools.readChecksumManifest(join(archivesDir, 'checksums.sha256'));

    for (const entry of unpackTools.getToolArchiveManifest()) {
      expect(manifest.get(entry.archiveName), `${entry.archiveName} is missing from checksums.sha256`).toBeDefined();
      await expect(sha256(join(archivesDir, entry.archiveName))).resolves.toBe(manifest.get(entry.archiveName));
    }
  });

  it('covers, verifies, and smoke-unpacks every shipped tar.gz tool archive through the public helper', async () => {
    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    const archivesDir = join(unpackTools.getToolsDir(), 'archives');
    const manifestPath = join(archivesDir, 'checksums.sha256');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));

    for (const entry of unpackTools.getToolArchiveManifest().filter((candidate) => candidate.archiveType === 'tar.gz')) {
      const archivePath = join(archivesDir, entry.archiveName);
      const unpackedDir = join(tempDir, entry.archiveName.replace(/\.tar\.gz$/, ''));

      expect(() => unpackTools.verifyArchiveChecksum(archivePath, manifestPath)).not.toThrow();
      await expect(unpackTools.unpackArchive(archivePath, unpackedDir)).resolves.toBeUndefined();
    }
  });

  it('smoke-unpacks the real shipped archives for the current platform', async () => {
    const unpackTools = require('../unpack-tools.cjs') as UnpackToolsModule;
    const platformDir = unpackTools.getPlatformDir();
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-real-'));
    const sourceArchives = join(unpackTools.getToolsDir(), 'archives');
    const targetArchives = join(root, 'archives');
    await mkdir(targetArchives, { recursive: true });

    for (const entry of unpackTools.getToolArchiveManifest().filter((candidate) => candidate.platformDir === platformDir)) {
      await copyFile(join(sourceArchives, entry.archiveName), join(targetArchives, entry.archiveName));
      if (entry.licenseName) {
        await mkdir(dirname(join(targetArchives, entry.licenseName)), { recursive: true });
        await copyFile(join(sourceArchives, entry.licenseName), join(targetArchives, entry.licenseName));
      }
    }
    await copyFile(join(sourceArchives, 'checksums.sha256'), join(targetArchives, 'checksums.sha256'));

    await expect(unpackTools.unpackTools({ platformDir, toolsDir: root })).resolves.toEqual({
      success: true,
      alreadyUnpacked: false,
    });
  });
});
