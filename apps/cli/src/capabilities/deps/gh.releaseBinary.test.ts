import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

vi.mock('@happier-dev/cli-common/providers', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/providers')>('@happier-dev/cli-common/providers');
  return {
    ...actual,
    downloadGitHubReleaseAsset: async ({ destinationPath }: { destinationPath: string }) => {
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, 'mock-archive', 'utf8');
    },
  };
});

vi.mock('@happier-dev/release-runtime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/release-runtime')>('@happier-dev/release-runtime');
  return {
    ...actual,
    planArchiveExtraction: ({ destDir }: { destDir: string }) => ({
      command: { cmd: 'mock-extract', args: [destDir] },
    }),
  };
});

vi.mock('@happier-dev/cli-common/process', () => ({
  runCommandStreaming: async ({ args }: { args: string[] }) => {
    const extractDir = args[0];
    if (!extractDir) return;
    const binaryName = process.platform === 'win32' ? 'gh.exe' : 'gh';
    const extractedBinPath = join(extractDir, 'gh-release', 'bin', binaryName);
    await mkdir(dirname(extractedBinPath), { recursive: true });
    await writeFile(extractedBinPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\necho gh\n', { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(extractedBinPath, 0o755);
  },
}));

const ORIGINAL_HOME = process.env.HAPPIER_HOME_DIR;
const envKeys = ['HAPPIER_HOME_DIR', 'PATH', 'PATHEXT'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeSystemGhBinary(): Promise<{ dir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-gh-path-'));
  tempDirs.add(dir);
  const binPath = await writeExecutableShim({
    dir,
    fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
    contents: process.platform === 'win32' ? '@echo off\r\necho gh\r\n' : '#!/bin/sh\necho gh\n',
  });
  return { dir, binPath };
}

function currentGhAssetName(): string {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'linux') return `gh_2.90.0_linux_${arch}.tar.gz`;
  if (process.platform === 'darwin') return `gh_2.90.0_macOS_${arch}.zip`;
  return `gh_2.90.0_windows_${arch}.zip`;
}

afterEach(async () => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  if (ORIGINAL_HOME === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_HOME;
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('gh release-binary installer', () => {
  it('detects a managed GitHub CLI binary in the Happier tools directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-gh-home-'));
    tempDirs.add(home);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });

    const { getGhDepStatus, ghBinPath, resolveExistingGhManagedBinPath, resolveGithubCliCommandPath } = await import('./gh');
    await mkdir(dirname(ghBinPath()), { recursive: true });
    await writeFile(ghBinPath(), '#!/bin/sh\necho gh\n', { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(ghBinPath(), 0o755);

    expect(resolveExistingGhManagedBinPath()).toBe(ghBinPath());
    expect(resolveGithubCliCommandPath()).toBe(ghBinPath());
    await expect(getGhDepStatus()).resolves.toMatchObject({
      installed: true,
      binPath: ghBinPath(),
      sourceKind: 'github_release_binary',
    });
  });

  it('prefers a system GitHub CLI on PATH for runtime resolution when both system and managed binaries exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-gh-prefer-system-home-'));
    tempDirs.add(home);
    const { dir, binPath: systemGhPath } = await createFakeSystemGhBinary();
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: dir });

    const { ghBinPath, resolveGithubCliCommandPath } = await import('./gh');
    await mkdir(dirname(ghBinPath()), { recursive: true });
    await writeFile(ghBinPath(), '#!/bin/sh\necho gh\n', { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(ghBinPath(), 0o755);

    expect(resolveGithubCliCommandPath()).toBe(systemGhPath);
  });

  it('reports a system GitHub CLI on PATH as installed without a managed binary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-gh-system-status-home-'));
    tempDirs.add(home);
    const { dir, binPath: systemGhPath } = await createFakeSystemGhBinary();
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: dir });

    const { getGhDepStatus, resolveExistingGhManagedBinPath } = await import('./gh');

    expect(resolveExistingGhManagedBinPath()).toBeNull();
    await expect(getGhDepStatus()).resolves.toMatchObject({
      installed: true,
      binPath: systemGhPath,
      sourceKind: 'github_release_binary',
    });
  });

  it('installs GitHub CLI from a release archive by copying the extracted bin/gh payload', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-gh-install-home-'));
    tempDirs.add(home);
    envScope.patch({ HAPPIER_HOME_DIR: home });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/cli/cli/releases/latest') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v2.90.0',
            assets: [
              {
                name: currentGhAssetName(),
                browser_download_url: 'https://example.test/gh.zip',
                digest: 'sha256:mock',
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { ghBinPath, ghInstallDir, installGh } = await import('./gh');
    expect(ghInstallDir()).toContain(home);

    await expect(installGh()).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(readFile(ghBinPath(), 'utf8')).resolves.toContain('gh');
  });
});
