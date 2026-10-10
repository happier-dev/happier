import { beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';

const token = 'connected-catalog-account';
const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
const service = { pluginId: 'happier.connected-account.test', localId: 'api' };

describe('connected service configuration catalog materialization', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);

  it('opens the exact qualified service and authentication mode from the row without a Settings mirror', async () => {
    const entry = { service, modeId: 'api-key', revision: 'configuration-9', values: { endpoint: 'https://api.example.test' }, secretRefs: {} };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'ready', revision: 4, record: { key: 'configurations', value: { v: 1, entries: [entry] } } } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).resolves.toEqual({
      revision: entry.revision, values: entry.values, secretRefs: {},
    });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'oauth' })).resolves.toBeNull();
  });

  it('refuses unavailable configuration rather than treating a configured service as unconfigured', async () => {
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).rejects.toMatchObject({
      code: 'connected_account_configuration_persistence_unavailable',
    });
  });

  it('never materializes the safe display projection of a partial configuration row', async () => {
    const entry = { service, modeId: 'api-key', revision: 'display-only', values: { endpoint: 'https://api.example.test' }, secretRefs: {} };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 5, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      connectedConfigurationCatalog: { status: 'partial', authority: 'active', revision: 4,
        record: { key: 'configurations', value: { v: 1, entries: [entry] } },
        diagnostics: [{ path: 'entries[1]', reason: 'invalid-stored-content' }] } });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: { token, encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }) });
    await expect(persistence.configuration.read({ kind: 'service', service, modeId: 'api-key' })).rejects.toMatchObject({
      code: 'connected_account_configuration_persistence_unavailable',
    });
  });
});
