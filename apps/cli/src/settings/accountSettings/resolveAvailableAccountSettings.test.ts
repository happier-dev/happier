import { accountSettingsParse } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';

import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import { resolveAvailableAccountSettings } from './resolveAvailableAccountSettings';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';

function credentials(token: string): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

describe('resolveAvailableAccountSettings', () => {
  const originalMode = process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;

  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.HAPPIER_ACCOUNT_SETTINGS_MODE;
    else process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = originalMode;
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not return the active Account B snapshot to a caller that supplied Account A credentials', async () => {
    const accountA = credentials('account-a');
    const accountB = credentials('account-b');
    const activeAccountB = {
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 4,
      loadedAtMs: 4,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(accountB),
    };
    setActiveAccountSettingsSnapshot(activeAccountB);
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';

    const resolved = await resolveAvailableAccountSettings({ credentials: accountA });

    expect(resolved).not.toBe(activeAccountB.settings);
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(
      resolveAccountSettingsScopeKey(accountA),
    );
  });
});
