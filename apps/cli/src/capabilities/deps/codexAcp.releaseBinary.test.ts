import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_ARCH_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'arch');
const ORIGINAL_HOME = process.env.HAPPIER_HOME_DIR;
const ORIGINAL_PATH = process.env.PATH;

const tempDirs = new Set<string>();

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createCodexAcpArchive(contents: string): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-archive-'));
  tempDirs.add(workDir);
  const binaryPath = join(workDir, 'codex-acp');
  await writeFile(binaryPath, contents, { mode: 0o755 });
  const archivePath = join(workDir, 'codex-acp.tar.gz');
  await tar.c({ gzip: true, cwd: workDir, file: archivePath }, ['codex-acp']);
  return await readFile(archivePath);
}

afterEach(async () => {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  }
  if (ORIGINAL_ARCH_DESCRIPTOR) {
    Object.defineProperty(process, 'arch', ORIGINAL_ARCH_DESCRIPTOR);
  }
  if (ORIGINAL_HOME === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_HOME;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('codexAcp release-binary installer', () => {
  it('installs the latest release asset into the managed current/bin path', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR || !ORIGINAL_ARCH_DESCRIPTOR) {
      throw new Error('Expected process.platform/process.arch to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...ORIGINAL_ARCH_DESCRIPTOR, value: 'arm64' });

    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const archiveBytes = await createCodexAcpArchive('#!/bin/sh\necho codex-acp\n');
    const archiveDigest = `sha256:${sha256Hex(archiveBytes)}`;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/zed-industries/codex-acp/releases/latest') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v0.9.5',
            assets: [
              {
                name: 'codex-acp-0.9.5-aarch64-apple-darwin.tar.gz',
                browser_download_url: 'https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-apple-darwin.tar.gz',
                digest: archiveDigest,
              },
            ],
          }),
        } as Response;
      }

      if (url === 'https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-apple-darwin.tar.gz') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            archiveBytes.buffer.slice(
              archiveBytes.byteOffset,
              archiveBytes.byteOffset + archiveBytes.byteLength,
            ),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const { codexAcpBinPath, getCodexAcpDepStatus, installCodexAcp } = await import('./codexAcp');

    await expect(installCodexAcp()).resolves.toEqual(expect.objectContaining({ ok: true }));

    const binPath = codexAcpBinPath();
    await expect(readFile(binPath, 'utf8')).resolves.toContain('codex-acp');
    await expect(stat(binPath)).resolves.toEqual(expect.objectContaining({ isFile: expect.any(Function) }));

    await expect(getCodexAcpDepStatus({ includeLatestVersion: true })).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        binPath,
        installedVersion: '0.9.5',
        latestVersionCheck: { ok: true, latestVersion: '0.9.5', label: 'v0.9.5' },
      }),
    );
  });

  it('uses the managed windows executable path and latest release lookup', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR || !ORIGINAL_ARCH_DESCRIPTOR) {
      throw new Error('Expected process.platform/process.arch to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });
    Object.defineProperty(process, 'arch', { ...ORIGINAL_ARCH_DESCRIPTOR, value: 'x64' });

    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-win-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/zed-industries/codex-acp/releases/latest') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v0.9.6',
            assets: [
              {
                name: 'codex-acp-0.9.6-x86_64-pc-windows-msvc.zip',
                browser_download_url: 'https://example.test/codex-acp-win.zip',
                digest: 'sha256:deadbeef',
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const { codexAcpBinPath, codexAcpInstallDir, getCodexAcpDepStatus } = await import('./codexAcp');
    await mkdir(dirname(codexAcpBinPath()), { recursive: true });
    await writeFile(codexAcpBinPath(), 'echo off\r\n', 'utf8');
    await writeFile(join(codexAcpInstallDir(), 'install-state.json'), JSON.stringify({
      installedVersion: '0.9.5',
      lastInstallLogPath: join(dirname(codexAcpBinPath()), 'install.log'),
    }), 'utf8');

    await expect(getCodexAcpDepStatus({ includeLatestVersion: true })).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        binPath: expect.stringMatching(/codex-acp\.exe$/),
        installedVersion: '0.9.5',
        latestVersionCheck: { ok: true, latestVersion: '0.9.6', label: 'v0.9.6' },
      }),
    );
  });

  it('removes legacy npm-managed codex-acp artifacts after installing the release binary', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR || !ORIGINAL_ARCH_DESCRIPTOR) {
      throw new Error('Expected process.platform/process.arch to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...ORIGINAL_ARCH_DESCRIPTOR, value: 'arm64' });

    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-cleanup-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const archiveBytes = await createCodexAcpArchive('#!/bin/sh\necho codex-acp\n');
    const archiveDigest = `sha256:${sha256Hex(archiveBytes)}`;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/zed-industries/codex-acp/releases/latest') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v0.9.5',
            assets: [
              {
                name: 'codex-acp-0.9.5-aarch64-apple-darwin.tar.gz',
                browser_download_url: 'https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-apple-darwin.tar.gz',
                digest: archiveDigest,
              },
            ],
          }),
        } as Response;
      }

      if (url === 'https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-apple-darwin.tar.gz') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            archiveBytes.buffer.slice(
              archiveBytes.byteOffset,
              archiveBytes.byteOffset + archiveBytes.byteLength,
            ),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const { codexAcpInstallDir, installCodexAcp } = await import('./codexAcp');
    const installDir = codexAcpInstallDir();
    await mkdir(join(installDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(installDir, 'node_modules', '.bin', 'codex-acp'), '#!/bin/sh\necho legacy\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    await writeFile(join(installDir, 'package.json'), '{"name":"legacy"}', 'utf8');
    await writeFile(join(installDir, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8');

    await expect(installCodexAcp()).resolves.toEqual(expect.objectContaining({ ok: true }));

    await expect(stat(join(installDir, 'current', 'bin', 'codex-acp'))).resolves.toEqual(
      expect.objectContaining({ isFile: expect.any(Function) }),
    );
    await expect(stat(join(installDir, 'node_modules'))).rejects.toThrow();
    await expect(stat(join(installDir, 'package.json'))).rejects.toThrow();
    await expect(stat(join(installDir, 'package-lock.json'))).rejects.toThrow();
  });

  it('detects legacy npm-style managed installs when current/bin is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-legacy-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const { codexAcpInstallDir, getCodexAcpDepStatus } = await import('./codexAcp');
    const legacyBinPath = join(
      codexAcpInstallDir(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
    );
    await mkdir(dirname(legacyBinPath), { recursive: true });
    await writeFile(legacyBinPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\necho legacy\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    await writeFile(
      join(codexAcpInstallDir(), 'install-state.json'),
      JSON.stringify({ installedVersion: '0.9.4', lastInstallLogPath: '/tmp/codex-acp.log' }),
      'utf8',
    );

    await expect(getCodexAcpDepStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        binPath: legacyBinPath,
        installedVersion: '0.9.4',
        lastInstallLogPath: '/tmp/codex-acp.log',
      }),
    );
  });

  it('ignores legacy npm-style managed installs when no system node runtime is available', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-legacy-missing-node-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;
    process.env.PATH = '';

    const { codexAcpInstallDir, getCodexAcpDepStatus } = await import('./codexAcp');
    const legacyBinPath = join(
      codexAcpInstallDir(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
    );
    await mkdir(dirname(legacyBinPath), { recursive: true });
    await writeFile(legacyBinPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\necho legacy\n', {
      encoding: 'utf8',
      mode: 0o755,
    });

    await expect(getCodexAcpDepStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: false,
        binPath: null,
      }),
    );
  });

  it('treats legacy npm-style managed installs as runnable when a managed JS runtime exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-legacy-managed-node-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;
    process.env.PATH = '';

    const managedNodePath = join(home, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    await writeFile(managedNodePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    if (process.platform !== 'win32') await chmod(managedNodePath, 0o755);
    process.env.HAPPIER_MANAGED_NODE_BIN = managedNodePath;

    const { codexAcpInstallDir, getCodexAcpDepStatus } = await import('./codexAcp');
    const legacyBinPath = join(
      codexAcpInstallDir(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
    );
    await mkdir(dirname(legacyBinPath), { recursive: true });
    await writeFile(legacyBinPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\necho legacy\n', {
      encoding: 'utf8',
      mode: 0o755,
    });

    await expect(getCodexAcpDepStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        binPath: legacyBinPath,
      }),
    );
  });

  it('fails closed for legacy npm-style managed installs when the explicit JS runtime override is invalid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-legacy-invalid-runtime-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const pathDir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-node-path-'));
    tempDirs.add(pathDir);
    const nodeOnPath = join(pathDir, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(nodeOnPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    if (process.platform !== 'win32') await chmod(nodeOnPath, 0o755);
    process.env.PATH = pathDir;
    process.env.HAPPIER_MANAGED_NODE_BIN = join(home, 'missing-node-runtime');

    const { codexAcpInstallDir, getCodexAcpDepStatus } = await import('./codexAcp');
    const legacyBinPath = join(
      codexAcpInstallDir(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
    );
    await mkdir(dirname(legacyBinPath), { recursive: true });
    await writeFile(legacyBinPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\necho legacy\n', {
      encoding: 'utf8',
      mode: 0o755,
    });

    await expect(getCodexAcpDepStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: false,
        binPath: null,
      }),
    );
  });

  it('includes the last background auto-update check timestamp in dep status', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-update-state-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const {
      codexAcpBinPath,
      codexAcpInstallDir,
      getCodexAcpDepStatus,
    } = await import('./codexAcp');
    const { writeRuntimeInstallableLastCheckAtMs } = await import('@/installables/runtime/runtimeInstallableUpdateState');

    const lastBackgroundUpdateCheckAtMs = 1_773_164_020_808;
    await mkdir(dirname(codexAcpBinPath()), { recursive: true });
    await writeFile(codexAcpBinPath(), '#!/bin/sh\necho codex-acp\n', { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(codexAcpBinPath(), 0o755);
    await writeFile(
      join(codexAcpInstallDir(), 'install-state.json'),
      JSON.stringify({ installedVersion: '0.9.5', lastInstallLogPath: '/tmp/codex-acp.log' }),
      'utf8',
    );
    await writeRuntimeInstallableLastCheckAtMs('codex-acp', lastBackgroundUpdateCheckAtMs);

    await expect(getCodexAcpDepStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        installedVersion: '0.9.5',
        lastBackgroundUpdateCheckAtMs,
      }),
    );
  });
});
