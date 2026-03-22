import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, INSTALLABLE_KEYS, type InstallableKey } from '@happier-dev/protocol';

import { ensureRuntimeInstallablesForLaunch } from './ensureRuntimeInstallablesForLaunch';
import type { RuntimeInstallableAdapter } from './runtimeInstallablesRegistry';

function createAdapter(overrides: Partial<RuntimeInstallableAdapter> = {}): RuntimeInstallableAdapter {
  return {
    key: INSTALLABLE_KEYS.CODEX_ACP,
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
});
