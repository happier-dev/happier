import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { downloadGitHubReleaseAssetMock, extractReleasePayloadRootFromArchiveMock } = vi.hoisted(() => ({
  downloadGitHubReleaseAssetMock: vi.fn(async ({ destinationPath }: { destinationPath: string }) => {
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, 'archive', 'utf8');
  }),
  extractReleasePayloadRootFromArchiveMock: vi.fn(async ({ extractDir }: { extractDir: string }) => {
    const root = join(extractDir, 'gh_2.74.2_macOS_arm64');
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh'), '#!/bin/sh\necho gh\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(join(root, 'bin', 'gh'), 0o755);
    }
    return root;
  }),
}));

vi.mock('@happier-dev/cli-common/agents', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/agents')>('@happier-dev/cli-common/agents');
  return {
    ...actual,
    downloadGitHubReleaseAsset: downloadGitHubReleaseAssetMock,
  };
});

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/firstPartyRuntime')>('@happier-dev/cli-common/firstPartyRuntime');
  return {
    ...actual,
    extractReleasePayloadRootFromArchive: extractReleasePayloadRootFromArchiveMock,
  };
});

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_ARCH_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'arch');
const ORIGINAL_HOME = process.env.HAPPIER_HOME_DIR;

const tempDirs = new Set<string>();

afterEach(async () => {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  if (ORIGINAL_ARCH_DESCRIPTOR) Object.defineProperty(process, 'arch', ORIGINAL_ARCH_DESCRIPTOR);
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
  it('installs the GitHub CLI release into the managed current/bin path', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR || !ORIGINAL_ARCH_DESCRIPTOR) {
      throw new Error('Expected process.platform/process.arch to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...ORIGINAL_ARCH_DESCRIPTOR, value: 'arm64' });

    const home = await mkdtemp(join(tmpdir(), 'happier-gh-home-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/cli/cli/releases/latest') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v2.74.2',
            assets: [{
              name: 'gh_2.74.2_macOS_arm64.zip',
              browser_download_url: 'https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_macOS_arm64.zip',
              digest: 'sha256:mock',
            }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { ghBinPath } = await import('./gh');
    const { GH_INSTALLABLE_DESCRIPTOR } = await import('@happier-dev/protocol/installables');
    const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import(
      '@/packagedRuntime/installables/sourceAdapters/githubReleaseBinary'
    );
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(GH_INSTALLABLE_DESCRIPTOR);

    await expect(adapter?.installOrUpgrade()).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(readFile(ghBinPath(), 'utf8')).resolves.toContain('gh');
    expect(downloadGitHubReleaseAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_macOS_arm64.zip',
    }));
  });

  it('does not leak GITHUB_TOKEN into install logs or persisted state on success or failure', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR || !ORIGINAL_ARCH_DESCRIPTOR) {
      throw new Error('Expected process.platform/process.arch to be configurable for this test');
    }
    process.env.HAPPIER_HOME_DIR = await mkdtempHome();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });

    const SECRET_TOKEN = 'ghp_supersecret_DO_NOT_LOG_THIS_TOKEN_VALUE';
    const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = SECRET_TOKEN;

    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('https://api.github.com/repos/cli/cli/releases/latest')) {
          return {
            ok: true,
            json: async () => ({
              tag_name: 'v2.74.2',
              name: 'GitHub CLI 2.74.2',
              assets: [{
                name: 'gh_2.74.2_macOS_arm64.zip',
                browser_download_url: 'https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_macOS_arm64.zip',
              }, {
                name: 'gh_2.74.2_checksums.txt',
                browser_download_url: 'https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_checksums.txt',
              }],
            }),
          } as Response;
        }
        if (url.endsWith('gh_2.74.2_checksums.txt')) {
          return {
            ok: true,
            text: async () =>
              'd86e5c0f2cd95a1d6d8a8a5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f  gh_2.74.2_macOS_arm64.zip\n',
          } as Response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }));

      const { GH_INSTALLABLE_DESCRIPTOR } = await import('@happier-dev/protocol/installables');
      const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import(
        '@/packagedRuntime/installables/sourceAdapters/githubReleaseBinary'
      );
      const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(GH_INSTALLABLE_DESCRIPTOR);
      const result = await adapter!.installOrUpgrade();
      expect(result.ok).toBe(true);

      // Read every file under the configured logs/state dir and assert no secret leaked.
      const homeDir = process.env.HAPPIER_HOME_DIR!;
      const { readdir } = await import('node:fs/promises');
      const collectFilesRecursive = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const result: string[] = [];
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) result.push(...await collectFilesRecursive(path));
          else result.push(path);
        }
        return result;
      };
      const allFiles = await collectFilesRecursive(homeDir);
      for (const file of allFiles) {
        const content = await readFile(file, 'utf8').catch(() => '');
        expect(content, `${file} must not contain GITHUB_TOKEN`).not.toContain(SECRET_TOKEN);
      }
    } finally {
      if (ORIGINAL_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
    }
  });
});

async function mkdtempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-gh-test-home-'));
  return dir;
}
