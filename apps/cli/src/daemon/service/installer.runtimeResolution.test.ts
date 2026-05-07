import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  ensureJavaScriptRuntimeExecutableMock,
  discoverInstalledDaemonServiceEntriesMock,
  resolveDaemonServiceRuntimeTargetMock,
  planDaemonServiceInstallMock,
  applyDaemonServiceInstallPlanMock,
  isBunMock,
  readDefaultManagedReleaseChannelMock,
  resolveDesiredShimTargetsMock,
  resolveInstalledFirstPartyComponentPathsMock,
} = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
  discoverInstalledDaemonServiceEntriesMock: vi.fn(async () => []),
  resolveDaemonServiceRuntimeTargetMock: vi.fn(() => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
  planDaemonServiceInstallMock: vi.fn(() => ({ files: [], commands: [] })),
  applyDaemonServiceInstallPlanMock: vi.fn(async () => undefined),
  isBunMock: vi.fn(() => true),
  readDefaultManagedReleaseChannelMock: vi.fn(async () => 'stable'),
  resolveDesiredShimTargetsMock: vi.fn(async (): Promise<Array<{ shimPath: string; binaryPath: string }>> => []),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn(() => ({ shimPaths: [] })),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('./runtimeTarget', () => ({
  resolveDaemonServiceRuntimeTarget: resolveDaemonServiceRuntimeTargetMock,
}));

vi.mock('./discoverInstalledDaemonServiceEntries', () => ({
  discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
}));

vi.mock('./plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan')>();
  return {
    ...actual,
    planDaemonServiceInstall: planDaemonServiceInstallMock,
  };
});

vi.mock('./apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apply')>();
  return {
    ...actual,
    applyDaemonServiceInstallPlan: applyDaemonServiceInstallPlanMock,
  };
});

vi.mock('@/utils/runtime', () => ({
  isBun: isBunMock,
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    readDefaultManagedReleaseChannel: readDefaultManagedReleaseChannelMock,
    resolveDesiredShimTargets: resolveDesiredShimTargetsMock,
    resolveInstalledFirstPartyComponentPaths: resolveInstalledFirstPartyComponentPathsMock,
  };
});

describe('installDaemonService runtime resolution', () => {
  afterEach(() => {
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/node');
    discoverInstalledDaemonServiceEntriesMock.mockReset();
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([]);
    resolveDaemonServiceRuntimeTargetMock.mockReset();
    resolveDaemonServiceRuntimeTargetMock.mockReturnValue({
      nodePath: '/managed/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });
    planDaemonServiceInstallMock.mockReset();
    planDaemonServiceInstallMock.mockReturnValue({ files: [], commands: [] });
    applyDaemonServiceInstallPlanMock.mockReset();
    applyDaemonServiceInstallPlanMock.mockResolvedValue(undefined);
    isBunMock.mockReset();
    isBunMock.mockReturnValue(true);
    readDefaultManagedReleaseChannelMock.mockReset();
    readDefaultManagedReleaseChannelMock.mockResolvedValue('stable');
    resolveDesiredShimTargetsMock.mockReset();
    resolveDesiredShimTargetsMock.mockResolvedValue([]);
    resolveInstalledFirstPartyComponentPathsMock.mockReset();
    resolveInstalledFirstPartyComponentPathsMock.mockReturnValue({ shimPaths: [] });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('resolves a node runtime even when the parent process is bun-hosted', async () => {
    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      instanceId: 'cloud',
      runCommands: false,
    });

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
      isBunRuntime: false,
      currentExecPath: process.execPath,
      processEnv: process.env,
    });
    expect(resolveDaemonServiceRuntimeTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeExecutable: '/managed/node',
      }),
    );
  });

  it('uses the managed default release-channel shim for default-following installs', async () => {
    readDefaultManagedReleaseChannelMock.mockResolvedValueOnce('publicdev');
    resolveDesiredShimTargetsMock.mockResolvedValueOnce([{ shimPath: process.execPath, binaryPath: '/managed/happier' }]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      instanceId: 'cloud',
      targetMode: 'default-following',
      runCommands: false,
    });

    expect(readDefaultManagedReleaseChannelMock).toHaveBeenCalledWith({
      processEnv: process.env,
    });
    expect(resolveDesiredShimTargetsMock).toHaveBeenCalledWith({
      componentId: 'happier-daemon',
      channel: 'publicdev',
      processEnv: process.env,
    });
    expect(resolveDaemonServiceRuntimeTargetMock).toHaveBeenCalledWith({
      currentExecPath: process.execPath,
      explicitNodePath: process.execPath,
    });
    expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
  });

  it('uses the persisted default release channel when daemon service install has no explicit channel', async () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-service-default-channel-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    writeFileSync(
      join(homeDir, 'default-cli-release-channel.json'),
      `${JSON.stringify({ releaseChannel: 'publicdev' })}\n`,
      'utf8',
    );

    try {
      const { previewDaemonServiceInstall } = await import('./installer');

      await previewDaemonServiceInstall({
        platform: 'linux',
        uid: 123,
        userHomeDir: '/home/test',
        happierHomeDir: '/home/test/.happier',
        instanceId: 'cloud',
        targetMode: 'pinned',
      });

      expect(planDaemonServiceInstallMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'publicdev',
      }));
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
