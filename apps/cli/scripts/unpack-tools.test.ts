import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createRequire } from 'node:module';

import archiver from 'archiver';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type UnpackToolsModule = typeof import('./unpack-tools.cjs') & {
  getToolsDir: () => string;
  getToolArchiveManifest: () => readonly {
    tool: string;
    platformDir: string;
    archiveName: string;
    archiveType: 'tar.gz' | 'zip';
    binaryName: string;
    version: string;
    licenseName?: string;
    sha256?: string;
  }[];
  areToolsUnpacked: (toolsDir: string, platformDir: string, tools?: readonly string[]) => boolean;
  unpackTools: (options?: { platformDir?: string; toolsDir?: string; tools?: readonly string[] }) => Promise<{ success: boolean; alreadyUnpacked: boolean }>;
};

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
  it('extracts and reuses a requested optional tool without requiring the other archives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-selected-'));
    const archives = join(root, 'archives');
    const staging = join(root, 'staging');
    await mkdir(archives);
    await mkdir(staging);
    await writeFile(join(staging, 'difft.exe'), 'optional difft');
    await writeFile(join(archives, 'difftastic-LICENSE'), 'license');
    const archive = join(archives, 'difftastic-x64-win32.tar.gz');
    await createTarGz(staging, archive, ['difft.exe']);
    await writeManifestChecksums(archives, { 'difftastic-x64-win32.tar.gz': await sha256(archive) });
    const unpacker = require('./unpack-tools.cjs') as UnpackToolsModule;
    const options = { toolsDir: root, platformDir: 'x64-win32', tools: ['difftastic'] };
    await expect(unpacker.unpackTools(options)).resolves.toEqual({ success: true, alreadyUnpacked: false });
    await expect(readFile(join(root, 'unpacked', 'difft.exe'), 'utf8')).resolves.toBe('optional difft');
    expect(unpacker.areToolsUnpacked(root, 'x64-win32', ['difftastic'])).toBe(true);
    expect(unpacker.areToolsUnpacked(root, 'x64-win32')).toBe(false);
    await expect(unpacker.unpackTools(options)).resolves.toEqual({ success: true, alreadyUnpacked: true });
  });

  it('manifest includes zellij only for supported POSIX targets', () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    const manifest = unpackTools.getToolArchiveManifest();
    expect(manifest).toEqual(
      expect.arrayContaining([
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
    expect(manifest).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'zellij', platformDir: 'x64-win32' }),
    ]));
  });

  it('does not treat rg and difftastic alone as fully unpacked for zellij platforms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const unpacked = join(root, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, 'rg'), 'rg');
    await writeFile(join(unpacked, 'ripgrep.node'), 'node');
    await writeFile(join(unpacked, 'difft'), 'difft');

    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
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

    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).resolves.toEqual({
      success: true,
      alreadyUnpacked: true,
    });
  });

  it('extracts supported Windows tools without materializing zellij', async () => {
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

    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).resolves.toEqual({
      success: true,
      alreadyUnpacked: false,
    });

    await expect(readFile(join(root, 'unpacked', 'rg.exe'), 'utf8')).resolves.toBe('rg');
    await expect(stat(join(root, 'unpacked', 'zellij.exe'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'unpacked', 'zellij-LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'unpacked', '.happier-tools-manifest.json'), 'utf8')).resolves.not.toContain('"zellij"');
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

    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
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

    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    await expect(unpackTools.unpackTools({ platformDir: 'x64-win32', toolsDir: root })).rejects.toThrow(/missing checksum/i);
  });

  it('shipped checksum file covers every manifest archive and matches archive bytes', async () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    const archivesDir = join(unpackTools.getToolsDir(), 'archives');
    const checksumText = await readFile(join(archivesDir, 'checksums.sha256'), 'utf8');
    const checksums = new Map(
      checksumText
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
          if (!match) throw new Error(`Malformed checksum line: ${line}`);
          return [match[2].trim(), match[1].toLowerCase()] as const;
        }),
    );

    for (const entry of unpackTools.getToolArchiveManifest()) {
      expect(checksums.get(entry.archiveName), `${entry.archiveName} is missing from checksums.sha256`).toBeDefined();
      await expect(sha256(join(archivesDir, entry.archiveName))).resolves.toBe(checksums.get(entry.archiveName));
    }
  });

  it('smoke-unpacks the real shipped archives for the current platform', async () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
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

describe('unpack-tools CLI entry', () => {
  it('finishes a successful postinstall unpack through natural exit, never process.exit()', async () => {
    // process.exit() can wedge Node 24 in NodePlatform::Shutdown (nodejs/node#54918);
    // the CI install hung right after this script printed its success line.
    const cliRoot = resolve(dirname(require.resolve('./unpack-tools.cjs')), '..');
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-entry-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(join(cliRoot, 'scripts', 'unpack-tools.cjs'), join(root, 'scripts', 'unpack-tools.cjs'));
    await cp(join(cliRoot, 'tools', 'archives'), join(root, 'tools', 'archives'), { recursive: true });
    const exitLog = join(root, 'process-exit.log');
    const preload = join(root, 'record-process-exit.cjs');
    await writeFile(preload, [
      "const fs = require('node:fs');",
      'const exit = process.exit;',
      'process.exit = function recordedExit(code) {',
      "  fs.writeFileSync(process.env.HAPPIER_TEST_EXIT_LOG, String(code));",
      '  return exit.call(process, code);',
      '};',
    ].join('\n'));

    const result = spawnSync(process.execPath, ['--require', preload, join(root, 'scripts', 'unpack-tools.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_TEST_EXIT_LOG: exitLog,
        NODE_PATH: [join(cliRoot, 'node_modules'), join(cliRoot, '..', '..', 'node_modules')].join(delimiter),
      },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Tools unpacked successfully');
    expect(existsSync(exitLog)).toBe(false);
  });
});
