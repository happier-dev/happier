import { describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  CODEX_ACP_DEP_ID,
  INSTALLABLE_KEYS,
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol';
import { CODEX_ACP_INSTALLABLE_DESCRIPTOR } from '@happier-dev/plugins-codex/agent/installables/codexAcp';

import { ensureRuntimeInstallablesForLaunch } from './ensureForLaunch';
import type { RuntimeInstallableAdapter } from './registry';

const CODEX_ACP_INSTALLABLES_REGISTRY = resolveInstallablesRegistry({
  bundledFirstPartyPlugins: [{
    owner: {
      provenance: 'bundled_first_party_plugin',
      ownerId: 'happier.agent.codex',
      pluginId: 'happier.agent.codex',
    },
    descriptor: CODEX_ACP_INSTALLABLE_DESCRIPTOR,
  }],
});

function createAdapter(overrides: Partial<RuntimeInstallableAdapter> = {}): RuntimeInstallableAdapter {
  return {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    capabilityId: CODEX_ACP_DEP_ID,
    detectLaunchResolution: vi.fn(async () => ({
      availability: { ok: true as const },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    })),
    installOrUpgrade: vi.fn(async () => ({ ok: true as const, logPath: '/tmp/install.log' })),
    runBackgroundAutoUpdateCheck: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('ensureRuntimeInstallablesForLaunch', () => {
  it('installs missing managed prerequisites when auto-install is enabled', async () => {
    const adapter = createAdapter();
    const detectLaunchResolution = vi
      .mocked(adapter.detectLaunchResolution)
      .mockResolvedValueOnce({
        availability: { ok: false as const, errorMessage: 'codex-acp is not available on PATH' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })
      .mockResolvedValueOnce({
        availability: { ok: true as const },
        canAutoInstall: false,
        canBackgroundAutoUpdate: true,
      });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
          installablesRegistry: CODEX_ACP_INSTALLABLES_REGISTRY,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        },
        {
          getRuntimeInstallableAdapter: async (key: InstallableKey) => {
            expect(key).toBe(INSTALLABLE_KEYS.CODEX_ACP);
            return adapter;
          },
        },
      ),
    ).resolves.toEqual({ ok: true, installedKeys: [INSTALLABLE_KEYS.CODEX_ACP] });

    expect(detectLaunchResolution).toHaveBeenCalledTimes(2);
    expect(adapter.installOrUpgrade).toHaveBeenCalledTimes(1);
    expect(adapter.runBackgroundAutoUpdateCheck).not.toHaveBeenCalled();
  });

  it('fails when autoInstallWhenNeeded=false leaves a required installable unavailable', async () => {
    const adapter = createAdapter({
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'codex-acp is not available on PATH' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
          installablesRegistry: CODEX_ACP_INSTALLABLES_REGISTRY,
          settings: accountSettingsParse({
            installablesPolicyByMachineId: {
              'machine-1': {
                'codex-acp': { autoInstallWhenNeeded: false },
              },
            },
          }),
          machineId: 'machine-1',
        },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: INSTALLABLE_KEYS.CODEX_ACP,
      errorMessage: 'codex-acp is not available on PATH',
      logPath: null,
    });

    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });

  it('fails when a required installable is unavailable and cannot be auto-installed', async () => {
    const adapter = createAdapter({
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'codex-acp managed install is disabled' },
        canAutoInstall: false,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
          installablesRegistry: CODEX_ACP_INSTALLABLES_REGISTRY,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: INSTALLABLE_KEYS.CODEX_ACP,
      errorMessage: 'codex-acp managed install is disabled',
      logPath: null,
    });

    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });

  it('does not auto-install consent-required installables even when policy enables auto-install', async () => {
    const pluginKey = 'consent-required-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.consent-required-tool',
      display: {
        name: 'Consent Required Tool',
      },
      description: 'A tool that requires explicit install consent',
      source: {
        kind: 'github_release_binary',
        repo: 'acme/consent-required-tool',
        distTag: 'latest',
      },
      binary: {
        commands: ['consent-required-tool'],
        systemFirst: true,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    });
    const installablesRegistry = resolveInstallablesRegistry({
      externalPlugins: [{
        owner: {
          provenance: 'external_plugin',
          ownerId: 'acme.installables',
          pluginId: 'acme.installables',
        },
        descriptor,
      }],
    });
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.consent-required-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'consent-required-tool is missing' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({
            installablesPolicyByMachineId: {
              'machine-1': {
                [pluginKey]: { autoInstallWhenNeeded: true },
              },
            },
          }),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: pluginKey,
      errorMessage: 'consent-required-tool is missing',
      logPath: null,
    });
    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });

  it('requires explicit first-install consent for managed PyPI wheel assets before any download', async () => {
    const pluginKey = 'pypi-wheel-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.pypi-wheel-tool',
      display: {
        name: 'PyPI Wheel Tool',
      },
      description: 'Runtime tool contributed through a PyPI wheel asset',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
        },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'auto',
      },
      binary: {
        commands: ['localharness'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: true,
        autoUpdateMode: 'auto',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
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
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.pypi-wheel-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'localharness is missing' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: pluginKey,
      errorMessage: 'localharness is missing',
      logPath: null,
    });
    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });

  it('enforces managed PyPI source install consent even when top-level consent says install is not required', async () => {
    const pluginKey = 'pypi-wheel-source-consent-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.pypi-wheel-source-consent-tool',
      display: {
        name: 'PyPI Wheel Source Consent Tool',
      },
      description: 'Runtime tool contributed through a PyPI wheel asset',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
        },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'auto',
      },
      binary: {
        commands: ['localharness'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: true,
        autoUpdateMode: 'auto',
      },
      consent: {
        install: 'not_required',
        update: 'not_required',
      },
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
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.pypi-wheel-source-consent-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'localharness is missing' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: pluginKey,
      errorMessage: 'localharness is missing',
      logPath: null,
    });
    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });

  it('returns the install error when auto-install fails', async () => {
    const adapter = createAdapter({
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'codex-acp is not available on PATH' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
      installOrUpgrade: vi.fn(async () => ({
        ok: false as const,
        errorMessage: 'network failure',
        logPath: '/tmp/codex-acp-install.log',
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
          installablesRegistry: CODEX_ACP_INSTALLABLES_REGISTRY,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: INSTALLABLE_KEYS.CODEX_ACP,
      errorMessage: 'network failure',
      logPath: '/tmp/codex-acp-install.log',
    });
  });

  it('starts background auto-update checks for managed installables with auto-update enabled', async () => {
    const adapter = createAdapter({
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: true as const },
        canAutoInstall: false,
        canBackgroundAutoUpdate: true,
      })),
    });
    const startBackgroundRuntimeInstallableUpdate = vi.fn(async () => {});

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
          installablesRegistry: CODEX_ACP_INSTALLABLES_REGISTRY,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        },
        {
          getRuntimeInstallableAdapter: async () => adapter,
          startBackgroundRuntimeInstallableUpdate,
        },
      ),
    ).resolves.toEqual({ ok: true, installedKeys: [] });

    expect(startBackgroundRuntimeInstallableUpdate).toHaveBeenCalledWith({
      adapter,
      installableKey: INSTALLABLE_KEYS.CODEX_ACP,
    });
  });

  it('does not start background auto-update checks when descriptor update consent is required', async () => {
    const pluginKey = 'pypi-wheel-update-consent-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.pypi-wheel-update-consent-tool',
      display: {
        name: 'PyPI Wheel Update Consent Tool',
      },
      description: 'Runtime tool with update consent required',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
        },
        executable: true,
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
        install: 'not_required',
        update: 'required',
      },
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
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.pypi-wheel-update-consent-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: true as const },
        canAutoInstall: false,
        canBackgroundAutoUpdate: true,
      })),
    });
    const startBackgroundRuntimeInstallableUpdate = vi.fn(async () => {});

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({
            installablesPolicyByMachineId: {
              'machine-1': {
                [pluginKey]: { autoUpdateMode: 'auto' },
              },
            },
          }),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
          startBackgroundRuntimeInstallableUpdate,
        },
      ),
    ).resolves.toEqual({ ok: true, installedKeys: [] });

    expect(startBackgroundRuntimeInstallableUpdate).not.toHaveBeenCalled();
  });

  it('does not start background auto-update checks when autoUpdateMode is off', async () => {
    const pluginKey = 'pypi-wheel-no-update-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.pypi-wheel-no-update-tool',
      display: {
        name: 'PyPI Wheel No Update Tool',
      },
      description: 'Runtime tool with managed background updates disabled',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
        },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'off',
      },
      binary: {
        commands: ['localharness'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'off',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
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
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.pypi-wheel-no-update-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: true as const },
        canAutoInstall: false,
        canBackgroundAutoUpdate: true,
      })),
    });
    const startBackgroundRuntimeInstallableUpdate = vi.fn(async () => {});

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
          startBackgroundRuntimeInstallableUpdate,
        },
      ),
    ).resolves.toEqual({ ok: true, installedKeys: [] });

    expect(startBackgroundRuntimeInstallableUpdate).not.toHaveBeenCalled();
  });

  it('enforces managed PyPI source autoUpdateMode=off over top-level and host auto-update policy', async () => {
    const pluginKey = 'pypi-wheel-source-no-update-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.pypi-wheel-source-no-update-tool',
      display: {
        name: 'PyPI Wheel Source No Update Tool',
      },
      description: 'Runtime tool with managed source background updates disabled',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
        },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'off',
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
        install: 'not_required',
        update: 'not_required',
      },
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
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.pypi-wheel-source-no-update-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: true as const },
        canAutoInstall: false,
        canBackgroundAutoUpdate: true,
      })),
    });
    const startBackgroundRuntimeInstallableUpdate = vi.fn(async () => {});

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({
            installablesPolicyByMachineId: {
              'machine-1': {
                [pluginKey]: { autoUpdateMode: 'auto' },
              },
            },
          }),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
          startBackgroundRuntimeInstallableUpdate,
        },
      ),
    ).resolves.toEqual({ ok: true, installedKeys: [] });

    expect(startBackgroundRuntimeInstallableUpdate).not.toHaveBeenCalled();
  });

  it('uses default policy from the provided resolved installables registry', async () => {
    const pluginKey = 'acme-runtime-tool' as InstallableKey;
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: pluginKey,
      key: pluginKey,
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.acme-runtime-tool',
      display: {
        name: 'Acme Runtime Tool',
      },
      description: 'Runtime tool contributed by a plugin',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/acme-runtime-tool',
      },
      binary: {
        commands: ['acme-runtime-tool'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    });
    const installablesRegistry = resolveInstallablesRegistry({
      externalPlugins: [{
        owner: {
          provenance: 'external_plugin',
          ownerId: 'acme.installables',
          pluginId: 'acme.installables',
        },
        descriptor,
      }],
    });
    const adapter = createAdapter({
      key: pluginKey,
      capabilityId: 'dep.acme-runtime-tool',
      detectLaunchResolution: vi.fn(async () => ({
        availability: { ok: false as const, errorMessage: 'acme-runtime-tool is missing' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      })),
    });

    await expect(
      ensureRuntimeInstallablesForLaunch(
        {
          installableKeys: [pluginKey],
          installablesRegistry,
          settings: accountSettingsParse({}),
          machineId: 'machine-1',
        } as Parameters<typeof ensureRuntimeInstallablesForLaunch>[0] & { installablesRegistry: InstallablesRegistry },
        {
          getRuntimeInstallableAdapter: async () => adapter,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      installableKey: pluginKey,
      errorMessage: 'acme-runtime-tool is missing',
      logPath: null,
    });
    expect(adapter.installOrUpgrade).not.toHaveBeenCalled();
  });
});
