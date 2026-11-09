import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { commitActiveConnectedAccountCatalog, commitActiveProfileCatalog, commitActivePromptLibraryCatalog,
  commitActiveSavedSecretCatalog, getActiveAccountSettingsSnapshotLifetimeToken,
  getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import * as persistence from '@/persistence';
import axios from 'axios';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';

const purpose = { consumer: { pluginId: 'happier.voice.test', localId: 'speech' }, purpose: 'voice-api' };
const service = { pluginId: 'happier.connected-account.test', localId: 'api' };
const value = { v: 1 as const, bindings: [{ purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected' } } }] };
const credentials = { token: 'catalog-publication-owner', encryption: null };

function publish(catalog: ConnectedAccountCatalogSnapshotV1) {
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
    ...{ connectedPurposeCatalog: catalog } });
}

describe('connected purpose catalog store', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it.each([true, false])('reads the last publication during refresh, waiting only for first publication (published=%s)', async published => {
    const credentials = { token: 'publication-ordering', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      ...(published ? { connectedPurposeCatalog: { status: 'ready' as const, revision: 3,
        record: { key: 'purposes' as const, value } } } : {}) });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let catalogReads = 0;
    // Only Home HTTP is delayed; the actual catalog publisher and binding store run.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) {
        catalogReads += 1;
        entered();
        await gate;
        return { status: 200, data: { status: 'present', revision: 4,
          content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      }
      throw new Error(`Unexpected Home read: ${path}`);
    });
    const refresh = refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', readMode: 'admitted' }, true);
    await reading;
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    let completed = false;
    const read = store.read(undefined, { published: true }).then(result => { completed = true; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(published);
      expect(catalogReads).toBe(1);
    } finally { release(); await refresh; }
    expect(await read).toEqual(published ? value : { v: 1, bindings: [] });
    // A genuinely published clear is authoritative, unlike temporary loading.
    expect(await store.read(undefined, { published: true })).toEqual({ v: 1, bindings: [] });
    expect(catalogReads).toBe(1);
  });

  it('does not wake purpose readers for unrelated or same-value catalog publications, but keeps binding and authority changes live', () => {
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    let wakes = 0;
    const subscription = createActiveAccountSettingsConnectedAccountPurposeBindingStore().subscribe(() => { wakes += 1; });
    const update = (patch: Partial<NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>>) => {
      const current = getActiveAccountSettingsSnapshot()!;
      const bound = { scopeKey: current.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
      const { profileCatalog, promptLibraryCatalog, connectedPurposeCatalog, connectedConfigurationCatalog,
        savedSecretResources, savedSecretCatalogState, ...preferences } = patch;
      if (profileCatalog) commitActiveProfileCatalog({ ...bound, catalog: profileCatalog });
      if (promptLibraryCatalog) commitActivePromptLibraryCatalog({ ...bound, catalog: promptLibraryCatalog });
      if (connectedPurposeCatalog) commitActiveConnectedAccountCatalog({ ...bound, key: 'purposes', catalog: connectedPurposeCatalog });
      if (connectedConfigurationCatalog) commitActiveConnectedAccountCatalog({ ...bound, key: 'configurations', catalog: connectedConfigurationCatalog });
      if (savedSecretResources !== undefined || savedSecretCatalogState !== undefined) commitActiveSavedSecretCatalog({ ...bound,
        resources: savedSecretResources ?? current.savedSecretResources ?? [], state: savedSecretCatalogState ?? current.savedSecretCatalogState ?? 'ready' });
      if (Object.keys(preferences).length > 0) setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!,
        ...preferences, settingsVersion: current.settingsVersion + 1 });
    };
    try {
      // These independent catalogs do not change purpose intent, configuration,
      // referenced material or the Account lifetime. A wake starts fresh reads.
      for (let index = 0; index < 8; index += 1) {
        update({ profileCatalog: { status: 'loading' }, promptLibraryCatalog: { status: 'loading' } });
      }
      expect(wakes).toBe(0);

      // An absent configuration catalog already means loading. Publishing that
      // same fact, or an equal purpose catalog, must not trigger binding reads.
      for (let index = 0; index < 25; index += 1) {
        update({ connectedConfigurationCatalog: { status: 'loading' },
          connectedPurposeCatalog: { status: 'ready', revision: 3,
            record: { key: 'purposes', value: { ...value, bindings: [...value.bindings] } } } });
      }
      expect(wakes).toBe(0);

      for (let index = 0; index < 25; index++) {
        update({ settings: accountSettingsParse({ analyticsOptOut: index % 2 === 0 }),
          rawSettings: { analyticsOptOut: index % 2 === 0 } });
      }
      expect(wakes).toBe(0);

      update({ connectedPurposeCatalog: { status: 'ready', revision: 4,
        record: { key: 'purposes', value: { v: 1, bindings: [] } } } });
      expect(wakes).toBe(1);
      update({ connectedConfigurationCatalog: { status: 'unavailable', reason: 'unreachable' } });
      expect(wakes).toBe(2);
      update({ savedSecretCatalogState: 'temporarily_unavailable' });
      expect(wakes).toBe(3);
      const secrets = [{ id: 'selected-secret', name: 'Fixture secret', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'fixture-only' }, createdAt: 1, updatedAt: 1 }];
      update({ settings: accountSettingsParse({ secrets }), rawSettings: { secrets } });
      expect(wakes).toBe(4);
      update({ settingsSecretsReadKeys: [new Uint8Array([1])] });
      expect(wakes).toBe(5);
      update({ scopeKey: 'replacement-account' });
      expect(wakes).toBe(6);
    } finally {
      subscription.dispose();
    }
    update({ connectedPurposeCatalog: { status: 'loading' } });
    expect(wakes).toBe(6);
  });

  it('refuses cached purpose truth when credentials for revalidation are unavailable', async () => {
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore().read()).rejects.toMatchObject({
      code: 'plugin_connected_account_settings_unavailable', details: { reason: 'credentials-unavailable' },
    });
  });

  it('refuses another Account publication when the supplied credentials do not own it', async () => {
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    const credentials = { token: 'different-account', encryption: null };
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).read(undefined, { published: true }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable', details: { reason: 'scope-retired' } });
  });

  it('refuses unavailable purpose truth instead of authorizing an empty default', async () => {
    publish({ status: 'ready', revision: 3, record: { key: 'purposes', value } });
    commitActiveConnectedAccountCatalog({ scopeKey: resolveAccountSettingsScopeKey(credentials),
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), key: 'purposes',
      catalog: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).read(undefined, { published: true }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable', details: { reason: 'account-mode-mismatch' } });
  });
});
