import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from '@/testkit/logger/captureOutput';

const {
  createReleaseBundleMock,
  fetchGitHubReleaseByTagMock,
  maybeRunDoctorRepairMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
  resolveCliBinaryAssetBundleFromReleaseAssetsMock,
  updateInstalledCliPayloadFromReleaseAssetsMock,
  maybeRunVersionGatedRuntimeMigrationMock,
} = vi.hoisted(() => ({
  createReleaseBundleMock: (version: string) => ({
    version,
    archive: { name: 'archive', url: 'https://example.test/archive.tgz' },
    checksums: { name: 'checksums.txt', url: 'https://example.test/checksums.txt' },
    checksumsSig: { name: 'checksums.txt.minisig', url: 'https://example.test/checksums.txt.minisig' },
  }),
  fetchGitHubReleaseByTagMock: vi.fn(async () => ({ assets: [{ name: 'archive', browser_download_url: 'https://example.test/archive.tgz' }] })),
  maybeRunDoctorRepairMock: vi.fn<(params: unknown) => Promise<boolean>>(async () => false),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn<(params: unknown) => Promise<void>>(async () => undefined),
  resolveCliBinaryAssetBundleFromReleaseAssetsMock: vi.fn(),
  updateInstalledCliPayloadFromReleaseAssetsMock: vi.fn(async () => ({
    updatedTo: '9.9.10',
    installRoot: '/tmp/happier/cli',
    previousVersionId: '0.2.2',
    hadLegacyCurrentInstallWithoutVersionMarkers: false,
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

vi.mock('./self/maybeRunDoctorRepair', () => ({
  maybeRunDoctorRepair: (params: unknown) => maybeRunDoctorRepairMock(params),
}));

vi.mock('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners', () => ({
  quiesceInstalledCliWindowsPayloadOwners: (params: unknown) => quiesceInstalledCliWindowsPayloadOwnersMock(params),
}));

describe('happier self update for binary installs', () => {
  beforeEach(() => {
    fetchGitHubReleaseByTagMock.mockReset();
    fetchGitHubReleaseByTagMock.mockResolvedValue({ assets: [{ name: 'archive', browser_download_url: 'https://example.test/archive.tgz' }] });
    resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReset();
    resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockImplementation(() => createReleaseBundleMock('9.9.10'));
    updateInstalledCliPayloadFromReleaseAssetsMock.mockReset();
    updateInstalledCliPayloadFromReleaseAssetsMock.mockResolvedValue({
      updatedTo: '9.9.10',
      installRoot: '/tmp/happier/cli',
      previousVersionId: '0.2.2',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
    });
    maybeRunDoctorRepairMock.mockReset();
    maybeRunDoctorRepairMock.mockResolvedValue(false);
    quiesceInstalledCliWindowsPayloadOwnersMock.mockReset();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockResolvedValue(undefined);
    maybeRunVersionGatedRuntimeMigrationMock.mockReset();
    maybeRunVersionGatedRuntimeMigrationMock.mockResolvedValue(false);
  });

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
      expect(quiesceInstalledCliWindowsPayloadOwnersMock.mock.invocationCallOrder[0]).toBeLessThan(
        updateInstalledCliPayloadFromReleaseAssetsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
        fromVersion: '0.2.2',
        toVersion: '9.9.10',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier self migrate',
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
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValue(createReleaseBundleMock('9.9.10-dev.1'));
      updateInstalledCliPayloadFromReleaseAssetsMock.mockResolvedValue({
        updatedTo: '9.9.10-dev.1',
        installRoot: '/tmp/happier/cli-dev',
        previousVersionId: '0.2.2-dev.1',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
      });
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
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValue(createReleaseBundleMock('9.9.10-dev.1'));
      updateInstalledCliPayloadFromReleaseAssetsMock.mockResolvedValue({
        updatedTo: '9.9.10-dev.1',
        installRoot: '/tmp/happier/cli-dev',
        previousVersionId: '0.2.2-dev.1',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
      });
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
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValue(createReleaseBundleMock('9.9.10-dev.1'));
      updateInstalledCliPayloadFromReleaseAssetsMock.mockResolvedValue({
        updatedTo: '9.9.10-dev.1',
        installRoot: '/tmp/happier/cli-dev',
        previousVersionId: '0.2.2-dev.1',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
      });
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
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValue(createReleaseBundleMock('9.9.10-dev.1'));
      updateInstalledCliPayloadFromReleaseAssetsMock.mockResolvedValue({
        updatedTo: '9.9.10-dev.1',
        installRoot: '/tmp/happier/cli-dev',
        previousVersionId: '0.2.2-dev.1',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
      });
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
      expect(maybeRunDoctorRepairMock).toHaveBeenCalledWith({
        migrationRan: false,
      });
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('refuses a stable binary self update when the resolved payload belongs to preview', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit);

    try {
      process.argv[1] = '/opt/happier/bin/happier';
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValue(createReleaseBundleMock('9.9.10-preview.3'));

      const { handleSelfCliCommand } = await import('./self');
      await expect(handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['happier', 'self', 'update'],
        terminalRuntime: null,
      })).rejects.toThrow('process.exit(1)');

      expect(fetchGitHubReleaseByTagMock).toHaveBeenCalled();
      expect(resolveCliBinaryAssetBundleFromReleaseAssetsMock).toHaveBeenCalled();
      expect(updateInstalledCliPayloadFromReleaseAssetsMock).not.toHaveBeenCalled();
      expect(maybeRunVersionGatedRuntimeMigrationMock).not.toHaveBeenCalled();
      expect(maybeRunDoctorRepairMock).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('does not match the stable release channel');
    } finally {
      process.argv = originalArgv;
      exitSpy.mockRestore();
      stdout.restore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('prints self update progress steps while resolving and installing a binary payload', async () => {
    const originalArgv = [...process.argv];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = captureStdout();

    try {
      process.argv[1] = '/opt/happier/bin/happier';
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'update'],
        rawArgv: ['happier', 'self', 'update'],
        terminalRuntime: null,
      });

      const output = stdout.text();
      expect(output).toContain('Resolving release metadata');
      expect(output).toContain('Downloading and installing payload');
      expect(output).toContain('Refreshing update cache');
    } finally {
      process.argv = originalArgv;
      stdout.restore();
      logSpy.mockRestore();
    }
  });

  it('does not mark a stable self check as updateable from a preview binary candidate', async () => {
    const originalArgv = [...process.argv];
    const originalHome = process.env.HAPPIER_HOME_DIR;
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-self-check-channel-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.argv[1] = '/opt/happier/bin/happier';
      resolveCliBinaryAssetBundleFromReleaseAssetsMock.mockReturnValueOnce(createReleaseBundleMock('9.9.10-preview.3'));

      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', 'check', '--quiet'],
        rawArgv: ['happier', 'self', 'check', '--quiet'],
        terminalRuntime: null,
      });

      const cache = JSON.parse(readFileSync(join(homeDir, 'cache', 'update.json'), 'utf8'));
      expect(cache.latest).toBeNull();
      expect(cache.updateAvailable).toBe(false);
    } finally {
      process.argv = originalArgv;
      if (originalHome === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = originalHome;
      }
      rmSync(homeDir, { recursive: true, force: true });
      logSpy.mockRestore();
    }
  });
});
