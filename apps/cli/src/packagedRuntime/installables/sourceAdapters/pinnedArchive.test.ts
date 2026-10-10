import { appendFile, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationState } = vi.hoisted(() => ({
  configurationState: { happyHomeDir: '' },
}));

const { downloadMock, extractRootMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  extractRootMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return configurationState.happyHomeDir;
    },
    get logsDir() {
      return `${configurationState.happyHomeDir}/logs`;
    },
  },
}));

vi.mock('@happier-dev/cli-common/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/agents')>();
  return { ...actual, downloadGitHubReleaseAsset: downloadMock };
});

vi.mock('@happier-dev/release-runtime/archiveExtraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/release-runtime/archiveExtraction')>();
  return { ...actual, extractArchivePayloadToDirectory: extractRootMock };
});

const tempDirs = new Set<string>();

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-pinned-archive-test-'));
  tempDirs.add(dir);
  return dir;
}

// Mirrors the official pinned `agy_acp_server` Linux asset: a `.par` executable at the
// archive payload root plus the platform launch argument the vendor requires.
const AGY_LINUX_ASSET = Object.freeze({
  archiveUrl: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
  sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
  executableSubpath: 'agy_acp_server.par',
  args: ['--uid='] as const,
});

const AGY_ARCHIVE_EXTRACTION_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 10 * 60_000,
});

function stageArchiveContaining(executableSubpath: string): void {
  downloadMock.mockImplementation(async (params: { destinationPath: string; digest?: string | null }) => {
    await writeFile(params.destinationPath, 'fake-archive-bytes');
  });
  extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(params.extractDir, { recursive: true });
    await write(join(params.extractDir, executableSubpath), '#!/bin/sh\necho agy');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  vi.resetModules();
});

describe('pinned archive runtime installable adapter', () => {
  it('launches the installed executable with the declared platform arguments', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);

    const adapter = mod.createPinnedArchiveRuntimeInstallableAdapter({
      installId: 'dep.antigravity.agy-acp-server',
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    });
    expect(adapter.resolveLaunchCommand).toBeDefined();
    const resolveLaunchCommand = adapter.resolveLaunchCommand;
    if (!resolveLaunchCommand) throw new Error('Pinned archive adapter must resolve its launch command');
    expect(adapter.detectCapabilityStatus).toBeDefined();
    const detectCapabilityStatus = adapter.detectCapabilityStatus;
    if (!detectCapabilityStatus) throw new Error('Pinned archive adapter must detect its capability status');

    // Before install the adapter fails closed but advertises that the host may install it.
    await expect(resolveLaunchCommand()).resolves.toMatchObject({
      ok: false,
      canAutoInstall: true,
    });
    // A missing managed install is a readable "not installed" status, not an absent one:
    // the UI installables planner is fail-closed on a null status and would never prewarm it.
    await expect(detectCapabilityStatus()).resolves.toEqual({
      installed: false,
      installedVersion: null,
      sourceKind: 'pinned_archive',
      lastInstallLogPath: null,
      lastBackgroundUpdateCheckAtMs: null,
    });

    // This installer writes no install log, and readers label `logPath` /
    // `lastInstallLogPath` as exactly that. The installed executable is not an
    // install log, so the truthful answer is "none".
    await expect(adapter.installOrUpgrade()).resolves.toEqual({ ok: true, logPath: null });

    const launch = await resolveLaunchCommand();
    expect(launch).toMatchObject({ ok: true, source: 'managed', args: ['--uid='] });
    if (!launch.ok) return;
    expect(launch.command.endsWith(join('current', 'agy_acp_server.par'))).toBe(true);
    await expect(detectCapabilityStatus()).resolves.toEqual({
      installed: true,
      installedVersion: '1.1.1',
      sourceKind: 'pinned_archive',
      lastInstallLogPath: null,
      lastBackgroundUpdateCheckAtMs: null,
      version: '1.1.1',
      availableVersion: '1.1.1',
    });
  });

  it('does not reuse a cached install pinned to a different version', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);

    const firstInstall = await mod.installPinnedArchive({
      installId: 'dep.antigravity.agy-acp-server',
      version: '1.1.0',
      asset: AGY_LINUX_ASSET,
      archiveExtractionLimits: AGY_ARCHIVE_EXTRACTION_LIMITS,
      platform: 'linux',
    });
    expect(firstInstall).toMatchObject({ ok: true, integrityDigest: `sha256:${AGY_LINUX_ASSET.sha256}` });
    expect(extractRootMock).toHaveBeenCalledWith(expect.objectContaining({
      limits: AGY_ARCHIVE_EXTRACTION_LIMITS,
    }));

    await expect(mod.resolveInstalledPinnedArchiveExecutable({
      installId: 'dep.antigravity.agy-acp-server',
      executableSubpath: AGY_LINUX_ASSET.executableSubpath,
      version: '1.1.1',
      platform: 'linux',
    })).resolves.toBeNull();
    await expect(mod.resolveInstalledPinnedArchiveExecutable({
      installId: 'dep.antigravity.agy-acp-server',
      executableSubpath: AGY_LINUX_ASSET.executableSubpath,
      version: '1.1.0',
      platform: 'linux',
    })).resolves.not.toBeNull();
  });

  it('refuses an executable subpath that escapes the managed install root', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining('agy_acp_server.par');

    await expect(mod.installPinnedArchive({
      installId: 'dep.antigravity.agy-acp-server',
      version: '1.1.1',
      asset: { ...AGY_LINUX_ASSET, executableSubpath: '../../../../etc/passwd' },
      platform: 'linux',
    })).resolves.toMatchObject({ ok: false, errorMessage: 'Pinned archive executable path is unsafe', errorCode: 'verification-failed' });

    await expect(mod.resolveInstalledPinnedArchiveExecutable({
      installId: 'dep.antigravity.agy-acp-server',
      executableSubpath: '../../../../etc/passwd',
      platform: 'linux',
    })).resolves.toBeNull();
  });

  it('fails closed when the archive does not contain the pinned executable', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining('some-other-binary');

    await expect(mod.installPinnedArchive({
      installId: 'dep.antigravity.agy-acp-server',
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    })).resolves.toMatchObject({
      ok: false,
      errorMessage: 'Pinned archive executable missing at agy_acp_server.par',
    });
  });

  it('cleans failed staging without replacing the current verified install', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);

    const installId = 'dep.antigravity.agy-acp-server';
    await expect(mod.installPinnedArchive({
      installId,
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    })).resolves.toMatchObject({ ok: true });
    const installedPath = await mod.resolveInstalledPinnedArchiveExecutable({
      installId,
      executableSubpath: AGY_LINUX_ASSET.executableSubpath,
      version: '1.1.1',
      platform: 'linux',
    });
    expect(installedPath).not.toBeNull();
    if (!installedPath) return;
    const installedBytes = await readFile(installedPath);

    extractRootMock.mockRejectedValueOnce(new Error('invalid archive'));
    await expect(mod.installPinnedArchive({
      installId,
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    })).resolves.toEqual({ ok: false, errorMessage: 'invalid archive', errorCode: 'verification-failed' });

    await expect(readFile(installedPath)).resolves.toEqual(installedBytes);
    const installRoot = join(configurationState.happyHomeDir, 'tools', installId);
    await expect(readdir(installRoot)).resolves.toEqual(['.lock', '.tmp', 'current']);
    await expect(readdir(join(installRoot, '.tmp'))).resolves.toEqual([]);
  });

  it('restores a mutated install through authoritative V2 ensure without extra downloads when clean', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const pinnedMod = await import('./pinnedArchive');
    const { createV2ManagedDependencySourceModel } = await import('@/plugins/runtime/invocation/services/managedDependencySourceModel');
    const { resolveExecutableManagedDependenciesRegistry } = await import('@/plugins/projection/registry/managedDependencyExecutables');
    const { createStablePluginManagedDependenciesHost } = await import('@/plugins/runtime/invocation/services/managedDependencies');
    const { createProductionManagedDependencySourceAdapter } = await import('@/plugins/runtime/invocation/services/managedDependencySourceAdapters');
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);

    const pluginId = 'acme.plugin';
    const localId = 'agy-acp-server';
    const installId = 'dep.antigravity.agy-acp-server' as const;
    const contribution = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId,
      manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
      daemonEntryPath: null,
      sourceSpec: {
        kind: 'path' as const,
        locator: `/plugins/${pluginId}`,
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
      definition: {
        id: localId,
        title: `${pluginId} ${localId}`,
        executable: 'agy_acp_server',
        sources: [{
          kind: 'pinnedArchive' as const,
          installId,
          version: '1.1.1',
          assetsByPlatform: {
            'linux-x64': { ...AGY_LINUX_ASSET },
          },
        }],
      },
    };
    const contributions = [contribution] as unknown as Parameters<typeof createV2ManagedDependencySourceModel>[0]['contributions'];
    const sourceModel = createV2ManagedDependencySourceModel({
      platform: 'linux',
      architecture: 'x64',
      contributions,
    });
    const installablesRegistry = resolveExecutableManagedDependenciesRegistry(contributions, {
      platform: 'linux',
      architecture: 'x64',
    });
    const host = createStablePluginManagedDependenciesHost({
      installablesRegistry,
      sourceModel,
      getSettings: () => ({}),
      resolveAdapter: async () => {
        throw new Error('legacy adapter must not be used');
      },
      resolveSourceAdapter: async (input) => createProductionManagedDependencySourceAdapter({
        ...input,
        platform: 'linux',
        architecture: 'x64',
      }),
      removeManagedInstall: async () => {},
      removeManagedSource: async () => {},
    });
    const service = host.bind(pluginId);
    const resolveParams = {
      installId,
      executableSubpath: AGY_LINUX_ASSET.executableSubpath,
      version: '1.1.1',
      platform: 'linux' as const,
    };

    await expect(service.ensure(localId)).resolves.toMatchObject({ state: 'ready' });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({ digest: `sha256:${AGY_LINUX_ASSET.sha256}` }));

    const executablePath = await pinnedMod.resolveInstalledPinnedArchiveExecutable(resolveParams);
    expect(executablePath).not.toBeNull();
    if (!executablePath) return;
    const cleanBytes = await readFile(executablePath);

    await appendFile(executablePath, '\n# mutated');
    await chmod(executablePath, 0o755);

    await expect(service.status(localId)).resolves.toMatchObject({ state: 'missing', id: localId });

    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);
    await expect(service.ensure(localId)).resolves.toMatchObject({ state: 'ready' });
    expect(downloadMock).toHaveBeenCalledTimes(2);
    const repairedPath = await pinnedMod.resolveInstalledPinnedArchiveExecutable(resolveParams);
    expect(repairedPath).not.toBeNull();
    if (!repairedPath) return;
    await expect(readFile(repairedPath)).resolves.toEqual(cleanBytes);

    await expect(service.ensure(localId)).resolves.toMatchObject({ state: 'ready' });
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the installed executable digest marker is missing or corrupt', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);

    const installId = 'dep.antigravity.agy-acp-server';
    const resolveParams = {
      installId,
      executableSubpath: AGY_LINUX_ASSET.executableSubpath,
      version: '1.1.1',
      platform: 'linux' as const,
    };

    await expect(mod.installPinnedArchive({
      installId,
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    })).resolves.toMatchObject({ ok: true });
    await expect(mod.resolveInstalledPinnedArchiveExecutable(resolveParams)).resolves.not.toBeNull();

    const currentDir = join(configurationState.happyHomeDir, 'tools', installId, 'current');
    const digestPath = join(currentDir, '.happier-managed-executable-sha256');
    await expect(readFile(digestPath, 'utf8')).resolves.toMatch(/^sha256:[0-9a-f]{64}$/i);

    await rm(digestPath, { force: true });
    await expect(mod.resolveInstalledPinnedArchiveExecutable(resolveParams)).resolves.toBeNull();

    // Repair, then corrupt the marker and prove it still fails closed.
    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);
    await expect(mod.installPinnedArchive({
      installId,
      version: '1.1.1',
      asset: AGY_LINUX_ASSET,
      platform: 'linux',
    })).resolves.toMatchObject({ ok: true });
    await writeFile(digestPath, 'not-a-digest', 'utf8');
    await expect(mod.resolveInstalledPinnedArchiveExecutable(resolveParams)).resolves.toBeNull();
  });
  it('resolves the running host asset from a projected pinned-archive descriptor and refuses an unpublished host', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./pinnedArchive');
    const { InstallableDependencyDescriptorSchema } = await import('@happier-dev/protocol/installables');
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'dep.antigravity.agy-acp-server',
      key: 'dep.antigravity.agy-acp-server',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.antigravity.agy-acp-server',
      display: { name: 'Antigravity ACP server' },
      description: 'Official pinned Antigravity ACP server.',
      source: {
        kind: 'pinned_archive',
        version: '1.1.1',
        assetsByPlatform: { 'linux-x64': AGY_LINUX_ASSET },
      },
      binary: { commands: ['agy_acp_server'], systemFirst: false, managedFallback: true },
      defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'off' },
      consent: { install: 'not_required', update: 'not_required', commandsPreviewRequired: false },
      stability: { experimental: true, supported: true },
    });

    const adapter = mod.getPinnedArchiveRuntimeInstallableAdapter(descriptor, {
      platform: 'linux',
      architecture: 'x64',
    });
    expect(adapter).not.toBeNull();
    expect(adapter?.key).toBe('dep.antigravity.agy-acp-server');
    expect(adapter?.capabilityId).toBe('dep.antigravity.agy-acp-server');

    stageArchiveContaining(AGY_LINUX_ASSET.executableSubpath);
    await expect(adapter?.installOrUpgrade()).resolves.toMatchObject({ ok: true });
    await expect(adapter?.detectCapabilityStatus?.()).resolves.toMatchObject({
      installed: true,
      installedVersion: '1.1.1',
    });

    // A host the pinned source does not publish is unsupported, not installable.
    expect(mod.getPinnedArchiveRuntimeInstallableAdapter(descriptor, {
      platform: 'darwin',
      architecture: 'x64',
    })).toBeNull();
    expect(mod.getPinnedArchiveRuntimeInstallableAdapter(descriptor, {
      platform: 'linux',
      architecture: 'ppc64',
    })).toBeNull();
  });
});
