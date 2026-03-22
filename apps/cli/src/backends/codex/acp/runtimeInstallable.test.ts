import { describe, expect, it, vi } from 'vitest';

import { detectCodexAcpLaunchResolution, runCodexAcpBackgroundAutoUpdateCheck } from './runtimeInstallable';

describe('codexAcpRuntimeInstallable', () => {
  it('marks an unresolved PATH fallback as auto-installable', async () => {
    const result = await detectCodexAcpLaunchResolution(
      {},
      {
        resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
        validateCodexAcpSpawnAvailability: () => ({ ok: false, errorMessage: 'codex-acp is not available on PATH' }),
        resolveExistingCodexAcpManagedBinPath: () => null,
      },
    );

    expect(result).toEqual({
      availability: { ok: false, errorMessage: 'codex-acp is not available on PATH' },
      canAutoInstall: true,
      canBackgroundAutoUpdate: false,
    });
  });

  it('skips auto-install when an explicit ACP override is configured', async () => {
    const result = await detectCodexAcpLaunchResolution(
      { env: { HAPPIER_CODEX_ACP_BIN: '/broken/codex-acp' } as NodeJS.ProcessEnv },
      {
        resolveCodexAcpSpawn: () => ({ command: '/broken/codex-acp', args: [] }),
        validateCodexAcpSpawnAvailability: () => ({ ok: false, errorMessage: 'Resolved command does not exist: /broken/codex-acp' }),
        resolveExistingCodexAcpManagedBinPath: () => null,
      },
    );

    expect(result).toEqual({
      availability: { ok: false, errorMessage: 'Resolved command does not exist: /broken/codex-acp' },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    });
  });

  it('runs background upgrades only for managed installs with a newer release', async () => {
    const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: '/tmp/codex-acp-install.log' }));

    await runCodexAcpBackgroundAutoUpdateCheck(
      {
        getCodexAcpDepStatus: async () => ({
          installed: true,
          installDir: '/tmp/codex-acp',
          binPath: '/tmp/codex-acp/current/bin/codex-acp',
          installedVersion: '0.1.0',
          sourceKind: 'github_release_binary' as const,
          lastInstallLogPath: null,
          lastBackgroundUpdateCheckAtMs: null,
          latestVersionCheck: { ok: true as const, latestVersion: '0.2.0', label: 'v0.2.0' },
        }),
        installCodexAcp: installOrUpgrade,
      },
    );

    expect(installOrUpgrade).toHaveBeenCalledTimes(1);
  });
});
