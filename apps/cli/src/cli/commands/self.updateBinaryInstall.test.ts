import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  fetchGitHubReleaseByTagMock,
  resolveCliBinaryAssetBundleFromReleaseAssetsMock,
  updateInstalledCliPayloadFromReleaseAssetsMock,
} = vi.hoisted(() => ({
  fetchGitHubReleaseByTagMock: vi.fn(async () => ({ assets: [{ name: 'archive', browser_download_url: 'https://example.test/archive.tgz' }] })),
  resolveCliBinaryAssetBundleFromReleaseAssetsMock: vi.fn(() => ({
    version: '9.9.10-preview.3',
    archive: { name: 'archive', url: 'https://example.test/archive.tgz' },
    checksums: { name: 'checksums.txt', url: 'https://example.test/checksums.txt' },
    checksumsSig: { name: 'checksums.txt.minisig', url: 'https://example.test/checksums.txt.minisig' },
  })),
  updateInstalledCliPayloadFromReleaseAssetsMock: vi.fn(async () => ({
    updatedTo: '9.9.10-preview.3',
    installRoot: '/tmp/happier/cli',
  })),
}));

vi.mock('@happier-dev/release-runtime/github', () => ({
  fetchGitHubReleaseByTag: fetchGitHubReleaseByTagMock,
}));

vi.mock('@/cli/runtime/update/binarySelfUpdate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/runtime/update/binarySelfUpdate')>();
  return {
    ...actual,
    resolveCliBinaryAssetBundleFromReleaseAssets: resolveCliBinaryAssetBundleFromReleaseAssetsMock,
    updateInstalledCliPayloadFromReleaseAssets: updateInstalledCliPayloadFromReleaseAssetsMock,
  };
});

describe('happier self update for binary installs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses the full-payload updater instead of replacing only the executable bytes', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.argv[1] = '/opt/happier/bin/happier';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['happier', 'self', 'update'],
        terminalRuntime: null,
      });

      expect(fetchGitHubReleaseByTagMock).toHaveBeenCalled();
      expect(resolveCliBinaryAssetBundleFromReleaseAssetsMock).toHaveBeenCalled();
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });
});
