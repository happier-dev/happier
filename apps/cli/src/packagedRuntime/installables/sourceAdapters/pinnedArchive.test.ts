import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { c as createTarArchive } from 'tar';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

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
  it.skipIf(process.platform === 'win32').each(['lima', 'lume'] as const)(
    'repairs missing %s through its Install Action, declared archive and dependency host before Check', async kind => {
      const plugin = kind === 'lima'
        ? (await import('@happier-dev/plugins-machine-lima/manifest')).LIMA_PLUGIN
        : (await import('@happier-dev/plugins-machine-lume/manifest')).LUME_PLUGIN;
      const { createV2ManagedDependencySourceModel } = await import('@/plugins/runtime/invocation/services/managedDependencySourceModel');
      const { resolveExecutableManagedDependenciesRegistry } = await import('@/plugins/projection/registry/managedDependencyExecutables');
      const { createStablePluginManagedDependenciesHost } = await import('@/plugins/runtime/invocation/services/managedDependencies');
      const { createProductionManagedDependencySourceAdapter } = await import('@/plugins/runtime/invocation/services/managedDependencySourceAdapters');
      const home = await makeTempHome();
      configurationState.happyHomeDir = home;
      const env = { ...process.env, HAPPIER_HOME_DIR: home, PATH: home };
      const pluginId = plugin.manifest.id;
      const localId = `${kind}-cli`;
      const contributions = (plugin.manifest.contributes.managedDependencies ?? []).map(definition => ({
        pluginId, provenance: 'external' as const, source: { kind: 'path' as const },
        manifestPath: join(home, 'plugin.json'), daemonEntryPath: null,
        sourceSpec: { kind: 'path' as const, locator: home, trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const },
        definition,
      })) satisfies readonly ResolvedInstallableContribution[];
      const definition = contributions.find(item => item.definition.id === localId)?.definition;
      const archive = definition?.sources.find(source => source.kind === 'pinnedArchive');
      if (archive?.kind !== 'pinnedArchive') throw new Error('Native dependency has no declared archive');
      const asset = archive.assetsByPlatform['darwin-arm64'];
      if (!asset) throw new Error('Native dependency has no Apple silicon archive');
      const fixtureRoot = join(home, 'archive-source');
      const fixtureExecutable = join(fixtureRoot, asset.executableSubpath);
      await mkdir(dirname(fixtureExecutable), { recursive: true });
      await writeFile(fixtureExecutable, `#!${process.execPath}
const argument = process.argv[2];
if (argument === '--version') process.stdout.write('${kind} version ${archive.version}');
else if (argument === 'info') process.stdout.write(JSON.stringify({ hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'] }));
else process.exit(2);
`);
      const fixtureArchive = join(home, 'vendor-fixture.tar.gz');
      await createTarArchive({ cwd: fixtureRoot, file: fixtureArchive, gzip: true, portable: true }, [asset.executableSubpath]);
      // Substitute downloaded bytes at the network boundary. Extraction,
      // promotion and installed-executable verification use their real owners.
      downloadMock.mockImplementation(async ({ destinationPath }: { destinationPath: string }) => {
        await copyFile(fixtureArchive, destinationPath);
      });
      const actualExtraction = await vi.importActual<typeof import('@happier-dev/release-runtime/archiveExtraction')>('@happier-dev/release-runtime/archiveExtraction');
      extractRootMock.mockImplementation(actualExtraction.extractArchivePayloadToDirectory);
      const dependencies = createStablePluginManagedDependenciesHost({
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributions, { platform: 'darwin', architecture: 'arm64' }),
        sourceModel: createV2ManagedDependencySourceModel({ platform: 'darwin', architecture: 'arm64', contributions }),
        env, getSettings: () => ({}),
        resolveAdapter: async () => { throw new Error('Unexpected legacy dependency'); },
        resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input, env, platform: 'darwin', architecture: 'arm64' }),
        removeManagedInstall: async () => { throw new Error('Repair must not remove installed dependencies'); },
      });
      const service = dependencies.bind(pluginId);
      const run: ExecService['run'] = async (input, options): Promise<PluginProcessResult> => {
        if (input.executable.kind !== 'managedDependency') throw new Error('Unexpected native executable');
        const executable = await dependencies.resolveExecutable(input.executable, pluginId, { requireReady: true });
        try {
          const args = [...(executable.args ?? []), ...(input.args ?? [])];
          const result = await promisify(execFile)(executable.command, args, { env, signal: options?.signal, encoding: 'buffer' });
          return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
            stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false, stderrTruncated: false };
        } finally { executable.release(); }
      };
      // Only the process, system-tool and HTTP boundaries used by these Actions
      // are supplied; managed-dependency selection and installation stay real.
      const services = {
        managedServices: { dependencies: service },
        exec: { run, systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: { pluginId, localId: 'ssh-keyscan' } }, executablePath: '/fixture/ssh-keyscan' }) } },
        http: { request: async (input: Parameters<HttpService['request']>[0]) => {
          const path = new URL(input.url).pathname;
          const value = path === '/lume/host/status' ? { version: archive.version }
            : path === '/lume/config' ? { cachingEnabled: true }
            : path === '/lume/vms' ? [] : undefined;
          if (value === undefined) throw new Error(`Unexpected native route: ${path}`);
          return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
        } },
      } as unknown as PluginTestServicesFixture;
      const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services });
      try {
        expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false });
        expect(downloadMock).not.toHaveBeenCalled();
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(service.ensure(localId, { signal: cancelled.signal })).rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
        expect(downloadMock).not.toHaveBeenCalled();
        downloadMock.mockRejectedValueOnce(Object.assign(new Error('Download unavailable'), { code: 'EACCES' }));
        await expect(kit.invokeAction('install', {}, { surface: 'plugin' })).rejects.toMatchObject({ code: 'plugin_managed_dependency_install_failed' });
        expect(await service.status(localId)).toMatchObject({ state: 'missing' });
        expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false });
        expect(await kit.invokeAction('install', {}, { surface: 'plugin' })).toBeNull();
        expect(downloadMock).toHaveBeenLastCalledWith(expect.objectContaining({ url: asset.archiveUrl, digest: `sha256:${asset.sha256}` }));
        const installed = join(home, 'tools', archive.installId, 'current', asset.executableSubpath);
        expect(await readFile(installed, 'utf8')).toContain(`${kind} version ${archive.version}`);
        expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
        const version = await run({ executable: { kind: 'managedDependency', id: { pluginId, localId } }, args: ['--version'] });
        expect(new TextDecoder().decode(version.stdout)).toBe(`${kind} version ${archive.version}`);
      } finally { await kit.dispose(); }
    });

  it('retains companion declarations beside a nested native executable', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    downloadMock.mockImplementation(async (params: { destinationPath: string }) => {
      await writeFile(params.destinationPath, 'archive fixture');
    });
    // Archive extraction is the OS/archive boundary; the real installer must
    // promote the complete payload rather than only its selected executable.
    extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(params.extractDir, 'package', 'lib'), { recursive: true });
      await writeFile(join(params.extractDir, 'package', 'lib', 'tsc'), 'native executable fixture');
      await writeFile(join(params.extractDir, 'package', 'lib', 'lib.d.ts'), 'interface Array<T> {}\n');
    });
    const { createPinnedArchiveRuntimeInstallableAdapter } = await import('./pinnedArchive');
    const adapter = createPinnedArchiveRuntimeInstallableAdapter({ installId: 'dep.language-fixture', version: '1',
      platform: 'linux', asset: { archiveUrl: 'https://example.test/native.tgz',
        sha256: 'a'.repeat(64), executableSubpath: 'package/lib/tsc' } });
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: true });
    const launch = await adapter.resolveLaunchCommand?.();
    expect(launch).toMatchObject({ ok: true });
    if (!launch?.ok) return;
    const { dirname } = await import('node:path');
    await expect(readFile(join(dirname(launch.command), 'lib.d.ts'), 'utf8')).resolves.toBe('interface Array<T> {}\n');
  });

  it('writes a minimal definition receipt through the installer and uses its canonical reader and remover', async () => {
    const home = await makeTempHome();
    configurationState.happyHomeDir = home;
    const payload = Buffer.from('#!/bin/sh\necho registry-agent\n');
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/agents')>('@happier-dev/cli-common/agents');
    downloadMock.mockImplementation(actual.downloadGitHubReleaseAsset);
    const server = createServer((_request, response) => response.end(payload));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture has no port');
      const mod = await import('./pinnedArchive');
      const adapter = mod.createPinnedArchiveRuntimeInstallableAdapter({
        installId: 'dep.registry-agent', version: '1', asset: {
          archiveUrl: `http://127.0.0.1:${address.port}/agent`, sha256: createHash('sha256').update(payload).digest('hex'),
          kind: 'executable', executableSubpath: 'agent',
        },
      });
      const managedAcpDefinition = { definitionId: 'definition-1', title: 'Registry agent', env: { PRIVATE_KEY: 'fixture-secret' } };
      await expect(adapter.installOrUpgrade({ managedAcpDefinition })).resolves.toMatchObject({ ok: true });
      const receipt = { version: '1', definitionId: 'definition-1', title: 'Registry agent', kind: 'archive' };
      const versionPath = join(home, 'tools', adapter.key, 'current', '.happier-managed-version');
      expect(JSON.parse(await readFile(versionPath, 'utf8'))).toEqual(receipt);
      await expect(mod.readPinnedArchiveManagedVersion({ installId: adapter.key })).resolves.toEqual(receipt);
      await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: true });
      await writeFile(versionPath, JSON.stringify({ ...receipt, futurePresentationField: 'ignored' }));
      await expect(mod.readPinnedArchiveManagedVersion({ installId: adapter.key })).resolves.toEqual(receipt);
      await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: true });
      await writeFile(versionPath, JSON.stringify({ version: '1', kind: 'archive' }));
      await expect(mod.readPinnedArchiveManagedVersion({ installId: adapter.key })).resolves.toBeNull();
      await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: false });
      await mod.removePinnedArchiveManagedInstall({ installId: adapter.key, env: { HAPPIER_HOME_DIR: home } });
      await expect(readFile(versionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('refuses a first-party computer driver descriptor without its mandatory checksum', async () => {
    const { getComputerCuaDriverRuntimeInstallableAdapter } = await import('./computerCuaDriver');
    const { InstallableDependencyDescriptorSchema, COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR } = await import('@happier-dev/protocol/installables');
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      ...COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR,
      source: { kind: 'pinned_archive', version: '1', assetsByPlatform: {
        [`${process.platform}-${process.arch}`]: { archiveUrl: 'https://example.test/driver.zip', executableSubpath: 'driver' },
      } },
    });
    expect(() => getComputerCuaDriverRuntimeInstallableAdapter(descriptor)).toThrow();
  });

  it('repairs the native Computer capability in its retained archive destination with the same pins and executable validation', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    stageArchiveContaining('cua-driver');
    const { createInstallableCapabilitiesFromContributions } = await import('@/capabilities/registry/installables');
    const { getArchiveDownloadInstallableAdapter } = await import('../registry');
    const { COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR, COMPUTER_CUA_DRIVER_VERSION } = await import('@happier-dev/protocol/installables');
    const capabilities = await createInstallableCapabilitiesFromContributions({});
    const capability = capabilities.find(entry => entry.descriptor.id === 'dep.computer-cua-driver');
    expect(capability).toBeDefined();
    await expect(capability?.invoke?.({ method: 'install' })).resolves.toEqual({ ok: true, result: { logPath: null } });
    const source = COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR.source;
    if (source.kind !== 'pinned_archive') throw new Error('Native Computer must use its pinned archive');
    const asset = source.assetsByPlatform[`${process.platform as 'darwin' | 'linux' | 'win32'}-${process.arch as 'arm64' | 'x64'}`];
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({ url: asset?.archiveUrl, digest: `sha256:${asset?.sha256}` }));
    const archive = getArchiveDownloadInstallableAdapter('computer-cua-driver');
    const executable = join(configurationState.happyHomeDir, 'tools', 'computer-cua-driver', 'current', 'cua-driver');
    await expect(archive?.resolveInstalledExecutable()).resolves.toBe(executable);
    await expect(capability?.detect({ request: { id: 'dep.computer-cua-driver' }, context: { cliSnapshot: null } })).resolves.toMatchObject({ installed: true, installedVersion: COMPUTER_CUA_DRIVER_VERSION });
    await appendFile(executable, 'changed');
    await expect(archive?.resolveInstalledExecutable()).resolves.toBeNull();
    await expect(capability?.detect({ request: { id: 'dep.computer-cua-driver' }, context: { cliSnapshot: null } })).resolves.toMatchObject({ installed: false });
  });
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
    await expect(adapter.installOrUpgrade()).resolves.toEqual({ ok: true, logPath: null, checksum: 'verified' });

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
    await expect(mod.readPinnedArchiveManagedVersion({ installId: 'dep.antigravity.agy-acp-server' })).resolves.toEqual({ version: '1.1.0' });
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
    await expect(readdir(getHappierTempRoot(join(installRoot, '.tmp')))).resolves.toEqual([]);
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
