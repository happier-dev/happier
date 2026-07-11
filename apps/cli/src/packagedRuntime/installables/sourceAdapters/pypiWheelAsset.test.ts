import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableKey,
} from '@happier-dev/protocol';

import { getRuntimeInstallableAdapter } from '../registry';

const { installPypiWheelAssetMock } = vi.hoisted(() => ({
  installPypiWheelAssetMock: vi.fn(),
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

const tempDirs = new Set<string>();

function createDescriptor() {
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
      distribution: 'google-antigravity',
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

  it('installs through the binary-safe wheel installer and can launch the managed executable', async () => {
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
    await expect(adapter.resolveLaunchCommand?.({ sourcePreference: 'managed-first' })).resolves.toEqual({
      ok: true,
      command: managedPath,
      args: [],
      source: 'managed',
    });
    expect(installPypiWheelAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      executable: true,
    }));
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
