import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshAccountSettingsForMinimumVersion: vi.fn(),
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: mocks.refreshAccountSettingsForMinimumVersion,
}));

import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';

describe('refreshAccountSettingsForDaemonRequest', () => {
  it('forces an authoritative fetch even when the active snapshot already satisfies the hint', async () => {
    mocks.refreshAccountSettingsForMinimumVersion.mockResolvedValueOnce({ settingsVersion: 14 });
    const credentials = {
      token: 'daemon-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };

    await expect(refreshAccountSettingsForDaemonRequest({
      credentials,
      accountSettingsVersionHint: 14,
    })).resolves.toEqual({ ok: true });

    expect(mocks.refreshAccountSettingsForMinimumVersion).toHaveBeenCalledExactlyOnceWith({
      credentials,
      minSettingsVersion: 14,
      mode: 'blocking',
      forceRefresh: true,
    });
  });
});
