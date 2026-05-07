import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  fetchGitHubReleaseByTagMock,
  maybeRunDoctorRepairMock,
  maybeRunVersionGatedRuntimeMigrationMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
  resolveCliBinaryAssetBundleFromReleaseAssetsMock,
  updateInstalledCliPayloadFromReleaseAssetsMock,
} = vi.hoisted(() => ({
  fetchGitHubReleaseByTagMock: vi.fn(async () => ({ assets: [{ name: 'archive', browser_download_url: 'https://example.test/archive.tgz' }] })),
  maybeRunDoctorRepairMock: vi.fn(async (_params: unknown) => false),
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn(async (_params: unknown) => false),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn(async (_params: unknown) => undefined),
  resolveCliBinaryAssetBundleFromReleaseAssetsMock: vi.fn(() => ({
    version: '9.9.10-preview.3',
    archive: { name: 'archive', url: 'https://example.test/archive.tgz' },
    checksums: { name: 'checksums.txt', url: 'https://example.test/checksums.txt' },
    checksumsSig: { name: 'checksums.txt.minisig', url: 'https://example.test/checksums.txt.minisig' },
  })),
  updateInstalledCliPayloadFromReleaseAssetsMock: vi.fn(async () => ({
    updatedTo: '9.9.10-preview.3',
    installRoot: '/tmp/happier/cli',
    previousVersionId: undefined,
    hadLegacyCurrentInstallWithoutVersionMarkers: false,
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

vi.mock('./self/maybeRunVersionGatedRuntimeMigration', () => ({
  maybeRunVersionGatedRuntimeMigration: (params: unknown) => maybeRunVersionGatedRuntimeMigrationMock(params),
}));

vi.mock('./self/maybeRunDoctorRepair', () => ({
  maybeRunDoctorRepair: (params: unknown) => maybeRunDoctorRepairMock(params),
}));

vi.mock('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners', () => ({
  quiesceInstalledCliWindowsPayloadOwners: (params: unknown) => quiesceInstalledCliWindowsPayloadOwnersMock(params),
}));

describe('happier self update for binary installs', () => {
  afterEach(() => {
    maybeRunDoctorRepairMock.mockReset();
    maybeRunVersionGatedRuntimeMigrationMock.mockReset();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockReset();
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
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'stable',
        processEnv: expect.objectContaining({
          HAPPIER_HOME_DIR: expect.any(String),
        }),
      });
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'stable',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
        fromVersion: undefined,
        toVersion: '9.9.10-preview.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
      });
      expect(maybeRunDoctorRepairMock).toHaveBeenCalledWith({
        migrationRan: false,
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
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'publicdev',
        processEnv: expect.objectContaining({
          HAPPIER_HOME_DIR: expect.any(String),
        }),
      });
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalled();
      expect(maybeRunDoctorRepairMock).toHaveBeenCalledWith({
        migrationRan: false,
      });
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('uses the raw hdev invoker when the packaged process argv path is generic', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.argv[1] = 'self';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['hdev', 'self', 'update'],
        terminalRuntime: null,
      });

      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Updated hdev to');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('uses the persisted default channel for the unsuffixed happier invoker', async () => {
    const originalArgv = [...process.argv];
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-self-update-default-channel-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      writeFileSync(
        join(homeDir, 'default-cli-release-channel.json'),
        `${JSON.stringify({ releaseChannel: 'publicdev' })}\n`,
        'utf8',
      );
      process.argv[1] = 'self';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['happier', 'self', 'update'],
        terminalRuntime: null,
      });

      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Updated hdev to');
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      process.argv = originalArgv;
      logSpy.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
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
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'publicdev',
        processEnv: expect.objectContaining({
          HAPPIER_HOME_DIR: expect.any(String),
        }),
      });
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledTimes(1);
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalled();
      expect(maybeRunDoctorRepairMock).toHaveBeenCalledWith({
        migrationRan: false,
      });
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
