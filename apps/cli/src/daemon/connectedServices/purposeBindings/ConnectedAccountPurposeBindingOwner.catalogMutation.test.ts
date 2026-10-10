import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as persistence from '@/persistence';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore, createConnectedAccountPurposeBindingOwner } from './ConnectedAccountPurposeBindingOwner';

const credentials = { token: 'purpose-row-writer', encryption: null };
const purpose = { consumer: { pluginId: 'happier.voice.test', localId: 'speech' }, purpose: 'voice-api' };
const binding = { purpose, target: { kind: 'account' as const,
  account: { service: { pluginId: 'happier.connected-account.test', localId: 'api' }, accountId: 'selected' } } };

describe('connected purpose row mutation', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  const concurrentBinding = { ...binding, purpose: { ...purpose,
    consumer: { pluginId: 'happier.voice.other', localId: 'speech' } } };
  function boundary(disposition: 'updated' | 'conflict' | 'lost-response' | 'updated-and-retired' | 'concurrent-reconciliation') {
    let record: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1,
      bindings: disposition === 'concurrent-reconciliation' ? [binding] : [] } };
    let revision = 3;
    let concurrentWrite = disposition === 'concurrent-reconciliation';
    const raw = { themePreference: 'dark' };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], connectedPurposeCatalog: { status: 'ready', record, revision } });
    // Only HTTP is replaced. Row schema, Account-mode admission, sealing and
    // snapshot publication run through the real canonical owners.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: record } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (!path.endsWith('/connected-accounts/purposes')) throw new Error(`Unexpected mutation: ${path}`);
      const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
      if (concurrentWrite) {
        concurrentWrite = false;
        record = { key: 'purposes', value: { v: 1, bindings: [binding, concurrentBinding] } };
        revision += 1;
        return { status: 409, data: { status: 'conflict', revision } };
      }
      if (disposition === 'conflict' || mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision: 4 } };
      if (mutation.content?.t !== 'plain') throw new Error('Expected the actual Plain Account envelope');
      record = mutation.content.v;
      revision += 1;
      if (disposition === 'lost-response') throw new Error('Response lost after durable commit');
      if (disposition === 'updated-and-retired') {
        const snapshot = getActiveAccountSettingsSnapshot();
        if (!snapshot) throw new Error('Missing Account at acknowledged boundary');
        setActiveAccountSettingsSnapshot({ ...snapshot,
          scopeKey: resolveAccountSettingsScopeKey({ token: 'replacement-after-ack', encryption: null }) });
      }
      return { status: 200, data: { status: 'updated', revision, cursor: 4 } };
    });
    return { read: () => ({ record, revision, raw }) };
  }

  it('publishes the durable opened row after ACK without mirroring or advancing preferences', async () => {
    const server = boundary('updated');
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    await expect(store.update(current => ({ ...current, bindings: [binding] }))).resolves.toEqual({ v: 1, bindings: [binding] });
    expect(server.read()).toEqual({ record: { key: 'purposes', value: { v: 1, bindings: [binding] } },
      revision: 4, raw: { themePreference: 'dark' } });
  });

  it('surfaces row CAS conflict without replaying user intent', async () => {
    const server = boundary('conflict');
    let intentRuns = 0;
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).update(current => {
      intentRuns += 1;
      return { ...current, bindings: [binding] };
    })).rejects.toMatchObject({ code: 'plugin_connected_account_settings_conflict' });
    expect(intentRuns).toBe(1);
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [] } });
  });

  it('reconciles a startup CAS conflict against the latest row before publishing without losing another consumer binding', async () => {
    const server = boundary('concurrent-reconciliation');
    const unexpected = async (): Promise<never> => { throw new Error('Reconciliation must not select or materialize accounts'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
      selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    let publishedBindings: unknown;
    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
      signal: new AbortController().signal,
      publish: () => { publishedBindings = server.read().record; },
    })).resolves.toBeUndefined();
    expect(publishedBindings).toEqual({ key: 'purposes', value: { v: 1, bindings: [concurrentBinding] } });
    expect(server.read().raw).toEqual({ themePreference: 'dark' });
    expect(server.read().revision).toBe(5);
  });

  it('keeps a lost mutation response outcome unknown even when the row actually committed', async () => {
    const server = boundary('lost-response');
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).update(current => ({
      ...current, bindings: [binding],
    }))).rejects.toMatchObject({ code: 'plugin_connected_account_settings_outcome_unknown' });
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding] } });
  });

  it('never submits an old Account intent using credentials observed after Account replacement', async () => {
    const server = boundary('updated');
    const nextCredentials = { token: 'next-purpose-account', encryption: null };
    // Credential persistence is an OS boundary; the domain store and Account
    // publication remain real during this reachable asynchronous Account switch.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(nextCredentials);
    const mutation = createActiveAccountSettingsConnectedAccountPurposeBindingStore().update(current => ({
      ...current, bindings: [binding],
    }));
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing observed Account');
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey(nextCredentials) });
    await expect(mutation).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [] } });
  });

  it('preserves a content-free acknowledged effect while refusing bindings after Account retirement', async () => {
    const server = boundary('updated-and-retired');
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).update(current => ({
      ...current, bindings: [binding],
    }))).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable',
      details: { reason: 'scope-retired', mutationStatus: 'updated', revision: 4 } });
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding] } });
  });

  it('refuses a cancelled purpose selection before any durable row effect', async () => {
    const server = boundary('updated');
    const controller = new AbortController();
    controller.abort();
    await expect(createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }).update(current => ({
      ...current, bindings: [binding],
    }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [] } });
  });
});
