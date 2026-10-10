import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1, SHARED_SAVED_SECRET_REF_V1_PREFIX } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import * as persistence from '@/persistence';
import { createActiveAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';

describe('service configuration canonical catalog settlement', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

  it.each(['updated', 'conflict', 'outcome_unknown', 'ack-retired'] as const)(
    'replaces one qualified service through the row CAS without replay after %s', async outcome => {
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'configuration-owner' })).toString('base64url')}.signature`, encryption: null };
      const scopeKey = resolveAccountSettingsScopeKey(credentials);
      const service = { pluginId: 'happier.connected-account.test', localId: 'api' };
      const neighbor = { service: { ...service, pluginId: 'happier.connected-account.neighbor' }, modeId: 'api-key',
        revision: 'neighbor-1', values: { endpoint: 'https://neighbor.example.test' }, secretRefs: {} };
      let record: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [neighbor, {
        service, modeId: 'api-key', revision: 'configuration-1', values: { endpoint: 'https://old.example.test' }, secretRefs: {},
      }] } };
      let revision = 4;
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
        connectedConfigurationCatalog: { status: 'ready', revision, record } });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/configurations')) return { status: 200, data: {
          status: 'present', revision, content: { t: 'plain', v: record } } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
        throw new Error(`Unrelated request: ${path}`);
      });
      let mutations = 0;
      vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/connected-accounts/configurations');
        mutations += 1;
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe(4);
        expect(mutation.settingsMutation).toBeUndefined();
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'configurations') throw new Error('Expected actual Plain configuration row');
        expect(mutation.content.v.value.entries).toContainEqual(neighbor);
        if (outcome === 'conflict') return { status: 409, data: { status: 'conflict', revision: 5 } };
        record = mutation.content.v;
        revision = 5;
        if (outcome === 'outcome_unknown') throw new Error('Response lost after commit');
        if (outcome === 'ack-retired') setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'replacement-account',
          settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 2, settingsSecretsReadKeys: [] });
        return { status: 200, data: { status: 'updated', revision, cursor: 5 } };
      });
      const owner = createQualifiedConnectedAccountDaemonPersistence({ credentials, getAccountEncryptionMode: async () => 'plain',
        secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }),
        createConfigurationRevision: () => 'configuration-5' });
      const result = await owner.configuration.replace({ target: { kind: 'service', service, modeId: 'api-key' },
        expectedRevision: 'configuration-1', replacement: { values: { endpoint: 'https://new.example.test' }, secretRefs: {} } });
      expect(result).toMatchObject(outcome === 'updated' ? { status: 'committed', record: { revision: 'configuration-5',
        values: { endpoint: 'https://new.example.test' }, secretRefs: {} } } : outcome === 'conflict'
        ? { status: 'conflict', code: 'connected_account_configuration_changed' }
        : outcome === 'ack-retired'
        ? { status: 'unavailable', code: 'connected_account_configuration_committed_readback_unavailable' }
        : { status: 'unavailable', code: 'connected_account_configuration_outcome_unknown' });
      expect(mutations).toBe(1);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
      if (outcome === 'ack-retired') {
        expect(revision).toBe(5);
        expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
        expect(getActiveAccountSettingsSnapshot()?.connectedConfigurationCatalog).toBeUndefined();
      }
    },
  );

  it('commits prepared credentials and the qualified configuration in one destination-only resource promotion', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'configuration-owner' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const service = { pluginId: 'happier.connected-account.test', localId: 'api' };
    const raw = { futurePreference: { retained: true } };
    let record: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [] } };
    let revision = 4;
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, settings: accountSettingsParse(raw), rawSettings: raw,
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
      connectedConfigurationCatalog: { status: 'ready', revision, record } });
    // Persisted credentials and HTTP are the only replacements. Real domain
    // preparation must send new resources and their row references atomically.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true } }, capabilities: {},
    }))));
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        settingsVersion: 9, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/configurations')) return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: record } } };
      if (path.endsWith('/saved-secrets/resources/materials')) return { status: 200, data: { resources: [] } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      if (path.includes('/settings/history')) return { status: 404, data: { error: 'unsupported' } };
      throw new Error(`Unrelated domain activation: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/saved-secrets/resources/promote');
      const promotion = SharedSavedSecretPromoteInputV1Schema.parse(body);
      expect(promotion.nextSettings).toBeNull();
      expect(promotion.expectedSettingsVersion).toBeUndefined();
      expect(promotion.referenceCensus).toEqual({ scope: 'catalogs', accountMode: 'plain',
        catalogs: { connectedConfigurations: revision } });
      const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(promotion.catalogMutations?.connectedConfigurations);
      expect(mutation.expectedRevision).toBe(revision);
      if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'configurations') throw new Error('Expected actual Plain configuration row');
      expect(mutation.content.v.value.entries[0]?.secretRefs.apiKey).toBe(formatSharedSavedSecretRefV1(promotion.resourceId));
      record = mutation.content.v;
      revision += 1;
      return { status: 200, data: { resourceId: promotion.resourceId, settingsVersion: 9 } };
    });
    const owner = createQualifiedConnectedAccountDaemonPersistence({ credentials,
      getAccountEncryptionMode: async () => 'plain',
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey }),
      createConfigurationRevision: () => 'configuration-5', createSecretId: () => 'prepared-api-key', now: () => 1 });
    await expect(owner.configuration.replaceForControl!({ target: { kind: 'service', service, modeId: 'api-key' },
      expectedRevision: null, values: { endpoint: 'https://api.example.test' }, currentSecretRefs: {},
      secretValues: { apiKey: 'prepared-value' }, occurrenceId: 'generation-1',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'npm' },
    })).resolves.toMatchObject({ status: 'committed', record: { revision: 'configuration-5',
      values: { endpoint: 'https://api.example.test' }, secretRefs: { apiKey: expect.stringContaining(SHARED_SAVED_SECRET_REF_V1_PREFIX) } } });
    expect(record.key === 'configurations' ? record.value.entries : []).toHaveLength(1);
    expect(getActiveAccountSettingsSnapshot()?.rawSettings).toEqual(raw);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    expect(getActiveAccountSettingsSnapshot()?.connectedConfigurationCatalog).toMatchObject({ status: 'ready', revision: 5, record });
  });
});
