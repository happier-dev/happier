import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';

const purpose = { consumer: { pluginId: 'happier.voice.test', localId: 'speech' }, purpose: 'voice-api' };
const service = { pluginId: 'happier.connected-account.test', localId: 'api' };
const value = { v: 1 as const, bindings: [{ purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected' } } }] };

function publish(catalog: ConnectedAccountCatalogSnapshotV1) {
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'captured-account',
    ...{ connectedPurposeCatalog: catalog } });
}

describe('connected purpose catalog store', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);

  it('reads the qualified Voice purpose from its opened row after the Settings root is absent', async () => {
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore().read()).resolves.toEqual(value);
  });

  it('refuses unavailable purpose truth instead of authorizing an empty default', async () => {
    publish({ status: 'unavailable', reason: 'account-mode-mismatch' });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore().read()).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
  });
});
