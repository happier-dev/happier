import { describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

describe('clearServerScopedAuthState', () => {
  it('clears only the selected Home registration and changes cursor', async () => {
    await withTempDir('happier-clear-machine-registration-', async homeDir => {
      vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
      vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'cloud');
      vi.resetModules();
      try {
        const { readMachineRegistration, updateMachineRegistration } = await import('@/daemon/machineIdentity/machineRegistrationStore');
        const { readAccountChangesCursors, writeAccountChangesCursor, updateSettings, readSettings } = await import('@/persistence');
        const { clearServerScopedAuthState } = await import('./clearServerScopedAuthState');
        const registration = {
          machineId: 'machine', accountId: 'account', machineIdByAccountId: { account: 'machine' },
          confirmedByServer: true, replacementCandidates: {
            account: { machineId: 'old-machine', replacementReason: 'reauth' as const, createdAt: 1 },
          },
        };
        await updateSettings(settings => ({ ...settings, onboardingCompleted: true }));
        await updateMachineRegistration(() => registration, 'cloud');
        await updateMachineRegistration(() => registration, 'other');
        await writeAccountChangesCursor('account', 42);
        await clearServerScopedAuthState('cloud/unsafe');
        await expect(readMachineRegistration('cloud')).resolves.toEqual({});
        await expect(readMachineRegistration('other')).resolves.toEqual(registration);
        expect((await readAccountChangesCursors()).cloud).toBeUndefined();
        expect((await readSettings()).onboardingCompleted).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
  });
});
