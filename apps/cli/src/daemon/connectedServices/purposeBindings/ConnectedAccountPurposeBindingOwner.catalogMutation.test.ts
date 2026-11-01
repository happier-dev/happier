import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as persistence from '@/persistence';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore, createConnectedAccountPurposeBindingOwner } from './ConnectedAccountPurposeBindingOwner';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const credentials = { token: 'purpose-row-writer', encryption: null };
const purpose = { consumer: { pluginId: 'happier.voice.test', localId: 'speech' }, purpose: 'voice-api' };
const binding = { purpose, target: { kind: 'account' as const,
  account: { service: { pluginId: 'happier.connected-account.test', localId: 'api' }, accountId: 'selected' } } };

describe('connected purpose row mutation', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  const concurrentBinding = { ...binding, purpose: { ...purpose,
    consumer: { pluginId: 'happier.voice.other', localId: 'speech' } } };
  function boundary(disposition: 'updated' | 'conflict' | 'lost-response' | 'updated-and-retired' | 'concurrent-reconciliation'
    | 'reconciliation-lost-response' | 'reconciliation-unknown' | 'reconciliation-read-unreachable') {
    const unknownReconciliation = disposition.startsWith('reconciliation-');
    let record: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1,
      bindings: unknownReconciliation ? [binding, concurrentBinding] : disposition === 'concurrent-reconciliation' ? [binding] : [] } };
    let revision = 3;
    let concurrentWrite = disposition === 'concurrent-reconciliation';
    let unknownWrite = unknownReconciliation;
    let readUnavailable = false;
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
      if (path.endsWith('/connected-accounts/purposes')) return readUnavailable
        ? { status: 503, data: { error: 'unavailable' } }
        : { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: record } } };
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
      if (unknownWrite) {
        unknownWrite = false;
        if (disposition === 'reconciliation-lost-response') {
          record = mutation.content.v;
          revision += 1;
          throw new Error('Response lost after durable reconciliation');
        }
        readUnavailable = disposition === 'reconciliation-read-unreachable';
        return { status: 500, data: { error: 'internal' } };
      }
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

  it('reads an acknowledged selection before its change hint reaches this daemon', async () => {
    const server = boundary('updated');
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    const writer = createCliConnectedAccountCatalogStore({ credentials });
    await expect(writer.writeRecord({ expectedRevision: server.read().revision,
      record: { key: 'purposes', value: { v: 1, bindings: [binding] } },
    })).resolves.toMatchObject({ status: 'updated', revision: 4 });
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({
      status: 'ready', revision: 3, record: { value: { bindings: [] } },
    });
    await expect(store.read()).resolves.toEqual({ v: 1, bindings: [binding] });
    await expect(writer.writeRecord({ expectedRevision: 4,
      record: { key: 'purposes', value: { v: 1, bindings: [] } },
    })).resolves.toMatchObject({ status: 'updated', revision: 5 });
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({ revision: 4 });
    await expect(store.read()).resolves.toEqual({ v: 1, bindings: [] });
  });

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

  it('keeps an unchanged declaration reconciliation at its captured revision without publishing another row', async () => {
    const server = boundary('updated');
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    await store.update(current => ({ ...current, bindings: [binding] }));
    const capturedRevision = server.read().revision;
    vi.mocked(axios.post).mockClear();
    const unexpected = async (): Promise<never> => { throw new Error('Reconciliation must not select or materialize accounts'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store, selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    for (let index = 0; index < 3; index += 1) {
      await owner.reconcileAuthorizedPurposes({
        consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [{ purpose, serviceRefs: [binding.target.account.service] }] }],
        signal: new AbortController().signal,
        publish: () => { expect(server.read().record.value).toEqual({ v: 1, bindings: [binding] }); },
      });
    }
    expect(server.read().revision).toBe(capturedRevision);
    expect(axios.post).not.toHaveBeenCalled();
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
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    let intentRuns = 0;
    await expect(store.update(current => {
      intentRuns += 1;
      return { ...current, bindings: [binding] };
    })).rejects.toMatchObject({ code: 'plugin_connected_account_settings_outcome_unknown' });
    expect(intentRuns).toBe(1);
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding] } });
    await expect(store.read()).resolves.toEqual({ v: 1, bindings: [binding] });
  });

  it.each(['reconciliation-lost-response', 'reconciliation-unknown'] as const)(
    'rereads an unknown startup write before publication and converges on the next publication (%s)', async disposition => {
      const server = boundary(disposition);
      const unexpected = async (): Promise<never> => { throw new Error('Reconciliation must not select or materialize accounts'); };
      const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
      const owner = createConnectedAccountPurposeBindingOwner({
        store, selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
        projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
      });
      let published = false;
      const reconcile = () => owner.reconcileAuthorizedPurposes({
        consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
        signal: new AbortController().signal,
        publish: () => {
          expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({
            status: 'ready', record: server.read().record, revision: server.read().revision,
          });
          published = true;
        },
      });
      await expect(reconcile()).resolves.toBeUndefined();
      expect(published).toBe(true);
      expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1,
        bindings: disposition === 'reconciliation-lost-response' ? [concurrentBinding] : [binding, concurrentBinding] } });
      await expect(store.read()).resolves.toEqual(server.read().record.value);
      await expect(reconcile()).resolves.toBeUndefined();
      expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [concurrentBinding] } });
      expect(server.read().raw).toEqual({ themePreference: 'dark' });
    },
  );

  it('defers startup pruning when an unknown write cannot be reread', async () => {
    const server = boundary('reconciliation-read-unreachable');
    const unexpected = async (): Promise<never> => { throw new Error('No credential selection or materialization'); };
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    const owner = createConnectedAccountPurposeBindingOwner({
      store, selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    let published = false;
    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
      signal: new AbortController().signal, publish: () => { published = true; },
    })).resolves.toBeUndefined();
    expect(published).toBe(true);
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({
      status: 'unavailable', reason: 'unreachable',
    });
    await expect(store.read()).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding, concurrentBinding] } });
  });

  it.each(['unavailable', 'outcome-unknown'] as const)(
    'releases the consumer after deferred pruning and superseded registry publication (%s)', async failure => {
      const server = boundary(failure === 'unavailable' ? 'concurrent-reconciliation' : 'reconciliation-unknown');
      if (failure === 'unavailable') {
        vi.mocked(axios.post).mockResolvedValueOnce({ status: 429, data: { error: 'unavailable' } });
      }
      const unexpected = async (): Promise<never> => { throw new Error('No credential selection or materialization'); };
      const owner = createConnectedAccountPurposeBindingOwner({
        store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
        selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
        projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
      });
      const consumerScopes = [{ consumer: purpose.consumer, authorizedPurposes: [] }];
      const signal = new AbortController().signal;
      const controller = createPluginReloadController();
      try {
        const superseded = await resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) });
        await expect(controller.adoptPreparedRuntimeRegistry({
          registry: superseded, changedPluginIds: [purpose.consumer.pluginId],
          durableRevision: 1, runningSessionDisposition: 'retainRunningSessions',
          beforePublish: async (_registry, publish) => owner.reconcileAuthorizedPurposes({
            consumerScopes, signal,
            publish: () => {
              controller.publishDurableRunningSessionDisposition({
                durableRevision: 2, changedPluginIds: [purpose.consumer.pluginId],
                runningSessionDisposition: 'retainRunningSessions',
              });
              publish();
            },
          }),
        })).rejects.toThrow(/superseded by newer durable revision 2/);
        expect(server.read().record.value).toMatchObject({ bindings: expect.arrayContaining([binding]) });

        const current = await resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) });
        await expect(controller.adoptPreparedRuntimeRegistry({
          registry: current, changedPluginIds: [purpose.consumer.pluginId],
          durableRevision: 2, runningSessionDisposition: 'retainRunningSessions',
          beforePublish: async (_registry, publish) => owner.reconcileAuthorizedPurposes({
            consumerScopes, signal, publish,
          }),
        })).resolves.toMatchObject({ ok: true, registry: current });
        expect(controller.getState().activeRegistry).toBe(current);
        expect(server.read().record.value).toEqual({ v: 1, bindings: [concurrentBinding] });
      } finally {
        await controller.shutdown();
      }
    },
  );

  it('publishes startup reconciliation when the purpose-row write is temporarily unreachable, retaining explicit bindings', async () => {
    const server = boundary('concurrent-reconciliation');
    vi.mocked(axios.post).mockResolvedValue({ status: 429, data: { error: 'unavailable' } });
    const unexpected = async (): Promise<never> => { throw new Error('Reconciliation must not select or materialize accounts'); };
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials });
    const owner = createConnectedAccountPurposeBindingOwner({
      store, selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    let published = false;
    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
      signal: new AbortController().signal,
      publish: () => { published = true; },
    })).resolves.toBeUndefined();
    expect(published).toBe(true);
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding] } });
    // A direct user mutation must still report failure, never claim a write.
    await expect(store.update(current => ({ ...current, bindings: [] }))).rejects.toMatchObject({
      code: 'plugin_connected_account_settings_unavailable', retryable: true,
      details: { reason: 'unreachable' },
    });
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

  it.each([[401, 'unauthorized'], [403, 'forbidden']] as const)('refuses publication after an HTTP %s authorization failure', async (status, code) => {
    const server = boundary('concurrent-reconciliation');
    vi.mocked(axios.post).mockResolvedValue({ status, data: { error: code } });
    const unexpected = async (): Promise<never> => { throw new Error('No credential selection or materialization'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
      selectTarget: unexpected, resolveTarget: unexpected, materializeAccount: unexpected,
      projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    let published = false;
    await expect(owner.reconcileAuthorizedPurposes({
      consumerScopes: [{ consumer: purpose.consumer, authorizedPurposes: [] }],
      signal: new AbortController().signal, publish: () => { published = true; },
    })).rejects.toMatchObject({ code });
    expect(published).toBe(false);
    expect(server.read().record).toEqual({ key: 'purposes', value: { v: 1, bindings: [binding] } });
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
