import { describe, expect, it, vi } from 'vitest';

import { createGhRuntimeInstallableAdapter } from './ghRuntimeInstallable';

describe('createGhRuntimeInstallableAdapter', () => {
  it('reuses the host source adapter installer instead of owning a GH installer', async () => {
    const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: '/tmp/host-gh-install.log' }));
    const hostAdapter = {
      key: 'gh' as const,
      capabilityId: 'dep.gh' as const,
      detectLaunchResolution: async () => ({
        availability: { ok: false as const, errorMessage: 'not installed' },
        canAutoInstall: true,
        canBackgroundAutoUpdate: false,
      }),
      installOrUpgrade,
      runBackgroundAutoUpdateCheck: async () => {},
    };

    const adapter = createGhRuntimeInstallableAdapter(hostAdapter);
    await adapter.installOrUpgrade();

    expect(adapter.installOrUpgrade).toBe(installOrUpgrade);
    expect(installOrUpgrade).toHaveBeenCalledTimes(1);
  });
});
