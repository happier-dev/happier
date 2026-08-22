import { access, chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableKey,
} from '@happier-dev/protocol';

import { getRuntimeInstallableAdapter } from '../registry';

type InstallPypiWheelAssetParams =
  Parameters<typeof import('@happier-dev/cli-common/agents').installPypiWheelAsset>[0];

const { installPypiWheelAssetMock } = vi.hoisted(() => ({
  installPypiWheelAssetMock: vi.fn(),
}));
const { spawnSupervisedPluginProcessMock } = vi.hoisted(() => ({
  spawnSupervisedPluginProcessMock: vi.fn(),
}));
const { configurationState } = vi.hoisted(() => ({
  configurationState: {
    happyHomeDir: '',
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return configurationState.happyHomeDir;
    },
    get logsDir() {
      return `${configurationState.happyHomeDir}/logs`;
    },
    installablesRuntimeAutoUpdateCheckIntervalMs: 60_000,
  },
}));

vi.mock('@happier-dev/cli-common/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/agents')>();
  return {
    ...actual,
    installPypiWheelAsset: installPypiWheelAssetMock,
  };
});

vi.mock('@/plugins/runtime/exec/processSupervisor', () => ({
  spawnSupervisedPluginProcess: spawnSupervisedPluginProcessMock,
}));

const tempDirs = new Set<string>();

function createDescriptor(distribution = 'google-antigravity') {
  return InstallableDependencyDescriptorSchema.parse({
    id: 'google-antigravity-localharness',
    key: 'google-antigravity-localharness',
    kind: 'dep',
    version: '1',
    capabilityId: 'dep.google-antigravity-localharness',
    display: {
      name: 'Antigravity Local Harness',
    },
    description: 'Local harness from a managed PyPI wheel asset',
    source: {
      kind: 'managed_pypi_wheel_asset',
      distribution,
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform: {
        'darwin-arm64': 'google/antigravity/bin/localharness',
        'linux-x64': 'google/antigravity/bin/localharness',
        'win32-x64': 'google/antigravity/bin/localharness.exe',
      },
      executable: true,
      compatibilityProbe: 'antigravity-localharness-v1',
      installConsent: 'host_managed_required',
      autoUpdateMode: 'auto',
    },
    binary: {
      commands: ['localharness'],
      systemFirst: false,
      managedFallback: true,
    },
    defaultPolicy: {
      autoInstallWhenNeeded: false,
      autoUpdateMode: 'auto',
    },
    consent: {
      install: 'required',
      update: 'required',
    },
  });
}

describe('managed_pypi_wheel_asset runtime adapter', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  it('resolves plugin-contributed managed PyPI wheel asset descriptors through the registry', async () => {
    const descriptor = createDescriptor();
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });

    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    expect(adapter.key).toBe('google-antigravity-localharness');
    expect(adapter.capabilityId).toBe('dep.google-antigravity-localharness');
  });

  it('recognizes canonical installed metadata for an underscore-named PyPI distribution', async () => {
    const descriptor = createDescriptor('google_antigravity');
    const homeDir = join(tmpdir(), `happier-pypi-adapter-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const platform = process.platform === 'win32'
      ? 'win32-x64'
      : process.platform === 'linux'
        ? 'linux-x64'
        : 'darwin-arm64';
    const managedPath = join(homeDir, 'tools', descriptor.key, 'versions', '0.1.5-test', 'bin', process.platform === 'win32' ? 'localharness.exe' : 'localharness');
    const metadataPath = join(homeDir, 'tools', descriptor.key, 'current.json');
    installPypiWheelAssetMock.mockImplementationOnce(async () => {
      await mkdir(join(managedPath, '..'), { recursive: true });
      await writeFile(managedPath, 'binary');
      await writeFile(metadataPath, `${JSON.stringify({
        sourceKind: 'managed_pypi_wheel_asset',
        installOwnerId: 'happier.antigravity',
        distribution: 'google-antigravity',
        version: '0.1.5',
        wheelFilename: 'google_antigravity-0.1.5-py3-none-test.whl',
        wheelDigest: `sha256:${'a'.repeat(64)}`,
        assetPath: process.platform === 'win32' ? 'google/antigravity/bin/localharness.exe' : 'google/antigravity/bin/localharness',
        platform,
        executablePath: managedPath,
        compatibilityProbe: { id: 'antigravity-localharness-v1', ok: true },
      }, null, 2)}\n`, 'utf8');
      if (process.platform !== 'win32') {
        await chmod(managedPath, 0o755);
      }
      return {
        executablePath: managedPath,
        version: '0.1.5',
        metadataPath,
      };
    });

    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await expect(adapter.installOrUpgrade()).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(installPypiWheelAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installOwnerId: 'happier.antigravity',
      }),
    );
    const canonicalManagedPath = await realpath(managedPath);
    await expect(adapter.resolveLaunchCommand?.({ sourcePreference: 'managed-first' })).resolves.toEqual({
      ok: true,
      command: canonicalManagedPath,
      args: [],
      source: 'managed',
    });
    expect(installPypiWheelAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      distribution: 'google_antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      executable: true,
    }));
  });

  it('does not borrow readiness from mismatched distribution, asset, executable, or probe metadata under the same installable key', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-source-mismatch-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const managedPath = join(homeDir, 'tools', descriptor.key, 'versions', '0.1.5-current', 'bin', 'localharness');
    const wrongExecutablePath = join(homeDir, 'tools', descriptor.key, 'versions', '9.9.9-lookalike', 'bin', 'lookalike');
    const metadataPath = join(homeDir, 'tools', descriptor.key, 'current.json');
    await mkdir(join(managedPath, '..'), { recursive: true });
    await writeFile(managedPath, 'matching');
    await chmod(managedPath, 0o755);
    await mkdir(join(wrongExecutablePath, '..'), { recursive: true });
    await writeFile(wrongExecutablePath, 'lookalike');
    await chmod(wrongExecutablePath, 0o755);
    const matchingMetadata = {
      sourceKind: 'managed_pypi_wheel_asset',
      installOwnerId: 'happier.antigravity',
      distribution: 'google-antigravity',
      version: '0.1.5',
      wheelFilename: 'google_antigravity-0.1.5-py3-none-macosx_14_0_arm64.whl',
      wheelDigest: `sha256:${'b'.repeat(64)}`,
      assetPath: 'google/antigravity/bin/localharness',
      platform: 'darwin-arm64',
      executablePath: managedPath,
      compatibilityProbe: { id: 'antigravity-localharness-v1', ok: true },
    } as const;
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    for (const metadata of [
      { ...matchingMetadata, installOwnerId: 'acme.lookalike' },
      { ...matchingMetadata, distribution: 'acme-lookalike' },
      { ...matchingMetadata, assetPath: 'acme/bin/lookalike' },
      { ...matchingMetadata, compatibilityProbe: { id: null, ok: true } },
      { ...matchingMetadata, executablePath: wrongExecutablePath },
      { ...matchingMetadata, version: '9.9.9' },
    ]) {
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      await expect(adapter.detectLaunchResolution({ env: { PATH: '' } })).resolves.toMatchObject({
        availability: { ok: false },
      });
      await expect(adapter.resolveLaunchCommand?.({
        sourcePreference: 'managed-first',
        env: { PATH: '' },
      })).resolves.toMatchObject({ ok: false });
    }
  });

  it('probes localharness with its framed startup handshake under supervised process ownership', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-probe-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const expectedRequest = Buffer.from(
      '200000000a00221c0a07686170706965721205302e302e301a0a74797065736372697074',
      'hex',
    );
    const response = Buffer.from(
      '1200000008f3d002120c6c6f6f706261636b2d6b6579',
      'hex',
    );
    const stdout = new PassThrough();
    const dispose = vi.fn(async () => undefined);
    const write = vi.fn(async (data: Uint8Array) => {
      expect(Buffer.from(data)).toEqual(expectedRequest);
      stdout.write(response.subarray(0, 5));
      stdout.write(response.subarray(5));
    });
    spawnSupervisedPluginProcessMock.mockReturnValueOnce({
      child: { stdout },
      handle: {
        pid: 123,
        write,
        closeStdin: vi.fn(),
        wait: vi.fn(),
        onOutput: vi.fn(),
        dispose,
      },
      readBufferedStderr: () => new Uint8Array(),
      requestTermination: vi.fn(),
      dispose,
    });
    installPypiWheelAssetMock.mockImplementationOnce(async (params: InstallPypiWheelAssetParams) => {
      if (!params.probeExecutable) throw new Error('expected compatibility probe');
      const probeResult = await params.probeExecutable({
        executablePath: '/managed/localharness',
        probeId: 'antigravity-localharness-v1',
        distribution: 'google-antigravity',
        version: '0.1.8',
      });
      expect(probeResult).toEqual({ ok: true });
      return {
        executablePath: '/managed/localharness',
        version: '0.1.8',
        metadataPath: join(homeDir, 'tools', descriptor.key, 'current.json'),
      };
    });
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await expect(adapter.installOrUpgrade()).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(spawnSupervisedPluginProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      command: '/managed/localharness',
      args: [],
      spawnOptions: { detached: true },
    }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a framed startup response that is not a valid localharness endpoint', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-probe-invalid-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const stdout = new PassThrough();
    const dispose = vi.fn(async () => undefined);
    spawnSupervisedPluginProcessMock.mockReturnValueOnce({
      child: { stdout },
      handle: {
        pid: 123,
        async write() {
          stdout.end(Buffer.from('03000000010203', 'hex'));
        },
        closeStdin: vi.fn(),
        wait: vi.fn(),
        onOutput: vi.fn(),
        dispose,
      },
      readBufferedStderr: () => new Uint8Array(),
      requestTermination: vi.fn(),
      dispose,
    });
    installPypiWheelAssetMock.mockImplementationOnce(async (params: InstallPypiWheelAssetParams) => {
      if (!params.probeExecutable) throw new Error('expected compatibility probe');
      const probeResult = await params.probeExecutable({
        executablePath: '/managed/localharness',
        probeId: 'antigravity-localharness-v1',
        distribution: 'google-antigravity',
        version: '0.1.8',
      });
      expect(probeResult).toMatchObject({ ok: false });
      return {
        executablePath: '/managed/localharness',
        version: '0.1.8',
        metadataPath: join(homeDir, 'tools', descriptor.key, 'current.json'),
      };
    });
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('fails a truncated startup frame without leaking child stderr and still disposes supervision', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-probe-failure-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const stdout = new PassThrough();
    const dispose = vi.fn(async () => undefined);
    spawnSupervisedPluginProcessMock.mockReturnValueOnce({
      child: { stdout },
      handle: {
        pid: 123,
        async write() {
          stdout.end(Buffer.from('0500000001', 'hex'));
        },
        closeStdin: vi.fn(),
        wait: vi.fn(),
        onOutput: vi.fn(),
        dispose,
      },
      readBufferedStderr: () => new Uint8Array(Buffer.from('credential=super-secret')),
      requestTermination: vi.fn(),
      dispose,
    });
    installPypiWheelAssetMock.mockImplementationOnce(async (params: InstallPypiWheelAssetParams) => {
      if (!params.probeExecutable) throw new Error('expected compatibility probe');
      const probeResult = await params.probeExecutable({
        executablePath: '/managed/localharness',
        probeId: 'antigravity-localharness-v1',
        distribution: 'google-antigravity',
        version: '0.1.8',
      });
      expect(probeResult).toMatchObject({ ok: false });
      if (probeResult.ok) throw new Error('expected compatibility probe failure');
      expect(probeResult.errorMessage).not.toContain('super-secret');
      throw new Error(`compatibility probe failed: ${probeResult.errorMessage}`);
    });
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({
      ok: false,
      errorMessage: expect.not.stringContaining('super-secret'),
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not auto-install on Linux when libc compatibility cannot be proven', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
    vi.spyOn(process.report, 'getReport').mockReturnValue({
      header: {},
    } as ReturnType<typeof process.report.getReport>);

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-adapter-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });

    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await expect(adapter.detectLaunchResolution({ env: { PATH: '' } })).resolves.toEqual({
      availability: {
        ok: false,
        errorMessage: expect.stringContaining('not supported'),
      },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    });
    await expect(adapter.installOrUpgrade()).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorMessage: expect.stringContaining('not supported'),
    }));
    expect(installPypiWheelAssetMock).not.toHaveBeenCalled();
  });

  it('removes only the managed install root when the dependency is uninstalled', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-remove-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const installRoot = join(homeDir, 'tools', descriptor.key);
    const unrelated = join(homeDir, 'tools', 'unrelated-tool', 'keep.txt');
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, 'current.json'), '{}');
    await mkdir(join(unrelated, '..'), { recursive: true });
    await writeFile(unrelated, 'keep');
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });
    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    expect(adapter.removeManagedInstall).toBeTypeOf('function');
    await adapter.removeManagedInstall?.();
    await expect(adapter.removeManagedInstall?.()).resolves.toBeUndefined();

    await expect(access(join(installRoot, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('does not run direct background updates when descriptor update consent is required', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');

    const descriptor = createDescriptor();
    const homeDir = join(tmpdir(), `happier-pypi-adapter-${Date.now()}-${Math.random()}`);
    tempDirs.add(homeDir);
    configurationState.happyHomeDir = homeDir;
    const managedPath = join(homeDir, 'tools', descriptor.key, 'versions', '0.1.5-test', 'bin', 'localharness');
    const metadataPath = join(homeDir, 'tools', descriptor.key, 'current.json');
    await mkdir(join(managedPath, '..'), { recursive: true });
    await writeFile(managedPath, 'binary');
    await chmod(managedPath, 0o755);
    await writeFile(metadataPath, `${JSON.stringify({
      sourceKind: 'managed_pypi_wheel_asset',
      installOwnerId: 'happier.antigravity',
      distribution: 'google-antigravity',
      version: '0.1.5',
      wheelFilename: 'google_antigravity-0.1.5-py3-none-test.whl',
      wheelDigest: `sha256:${'a'.repeat(64)}`,
      assetPath: 'google/antigravity/bin/localharness',
      platform: 'darwin-arm64',
      executablePath: managedPath,
      compatibilityProbe: { id: 'antigravity-localharness-v1', ok: true },
    }, null, 2)}\n`, 'utf8');
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.antigravity',
          pluginId: 'happier.antigravity',
        },
        descriptor,
      }],
    });

    const adapter = await getRuntimeInstallableAdapter(
      'google-antigravity-localharness' as InstallableKey,
      { installablesRegistry },
    );

    await adapter.runBackgroundAutoUpdateCheck();

    expect(installPypiWheelAssetMock).not.toHaveBeenCalled();
  });
});
