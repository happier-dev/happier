import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  fetchGitHubReleaseByTagMock,
  resolveCliBinaryAssetBundleFromReleaseAssetsMock,
  updateInstalledCliPayloadFromReleaseAssetsMock,
  maybeRunVersionGatedRuntimeMigrationMock,
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
    previousVersionId: '0.2.2',
  })),
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn<(params: unknown) => Promise<boolean>>(async () => false),
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

vi.mock('./self/maybeRunVersionGatedRuntimeMigration', () => ({
  maybeRunVersionGatedRuntimeMigration: (params: unknown) => maybeRunVersionGatedRuntimeMigrationMock(params),
}));

describe('happier self update for binary installs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    maybeRunVersionGatedRuntimeMigrationMock.mockReset();
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
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'stable',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
        fromVersion: '0.2.2',
        toVersion: '9.9.10-preview.3',
        argv: ['repair'],
        commandPath: 'happier self migrate',
      });
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('defaults binary self update to the publicdev ring when invoked through hdev', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.argv[1] = '/opt/happier/bin/hdev';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['hdev', 'self', 'update'],
        terminalRuntime: null,
      });

      expect(fetchGitHubReleaseByTagMock).toHaveBeenCalled();
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('defaults binary self update to the publicdev ring when invoked from the managed cli-dev current path', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.argv[1] = '/Users/test/.happier/cli-dev/current/happier';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['hdev', 'self', 'update'],
        terminalRuntime: null,
      });

      expect(fetchGitHubReleaseByTagMock).toHaveBeenCalled();
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('prints self update progress steps while resolving and installing a binary payload', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      process.argv[1] = '/opt/happier/bin/happier';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['happier', 'self', 'update'],
        terminalRuntime: null,
      });

      const output = stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('Resolving release metadata');
      expect(output).toContain('Downloading and installing payload');
      expect(output).toContain('Refreshing update cache');
    } finally {
      process.argv = originalArgv;
      stdoutWriteSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
