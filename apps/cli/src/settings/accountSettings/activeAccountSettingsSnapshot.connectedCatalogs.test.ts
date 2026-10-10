import { beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';

const connectedPurposeCatalog = { status: 'ready' as const, revision: 2,
  record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [] } } };
const connectedConfigurationCatalog = { status: 'ready' as const, revision: 3,
  record: { key: 'configurations' as const, value: { v: 1 as const, entries: [] } } };
function snapshot(scopeKey: string, settingsVersion: number) {
  return { source: 'network' as const, scopeKey, settingsVersion, loadedAtMs: 1,
    settings: accountSettingsParse({}), settingsSecretsReadKeys: [] };
}

describe('connected Account catalog lifetime', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  it('preserves opened connected catalogs across preference changes and retires them on Account replacement', () => {
    setActiveAccountSettingsSnapshot({ ...snapshot('account-a', 1), connectedPurposeCatalog, connectedConfigurationCatalog });
    setActiveAccountSettingsSnapshot(snapshot('account-a', 2));
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ connectedPurposeCatalog, connectedConfigurationCatalog });
    setActiveAccountSettingsSnapshot(snapshot('account-b', 1));
    expect(getActiveAccountSettingsSnapshot()).not.toHaveProperty('connectedPurposeCatalog');
    expect(getActiveAccountSettingsSnapshot()).not.toHaveProperty('connectedConfigurationCatalog');
  });

  it('withdraws opened connected authority when the Account decryption context changes', () => {
    setActiveAccountSettingsSnapshot({ ...snapshot('account-a', 1),
      connectedPurposeCatalog, connectedConfigurationCatalog });
    setActiveAccountSettingsSnapshot({ ...snapshot('account-a', 2),
      settingsSecretsReadKeys: [new Uint8Array(32).fill(7)] });
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toEqual({ status: 'loading' });
    expect(getActiveAccountSettingsSnapshot()?.connectedConfigurationCatalog).toEqual({ status: 'loading' });
  });
});
