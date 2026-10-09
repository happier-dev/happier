import { describe, expect, it } from 'vitest';
import {
  ConnectedAccountCatalogRecordV1Schema, ConnectedAccountCatalogRowMutationV1Schema,
  StoredConnectedAccountCatalogRecordV1Schema, sealConnectedAccountCatalogContentV1, openConnectedAccountCatalogContentV1,
  listConnectedConfigurationCatalogSavedSecretRefsV1, rewriteConnectedConfigurationCatalogSavedSecretRefsV1,
  type ConnectedAccountCatalogRecordV1,
} from './connectedAccountConfigurationRowsV1.js';
import { loadConnectedAccountCatalogV1, readRetainedConnectedAccountCatalogRecordV1 } from './connectedAccountCatalogV1.js';

const service = { pluginId: 'happier.connected-account.example', localId: 'cloud' };
const consumer = { pluginId: 'happier.agent.example', localId: 'coding' };
const configuration: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [
  { service, modeId: 'native-api', revision: 'revision-1', values: { adapter: { arbitraryField: 'retained' } }, secretRefs: { token: 'secret-old' } },
] } };
const purpose: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1, bindings: [
  { purpose: { consumer, purpose: 'native-api' }, target: { kind: 'group', service, groupId: 'pool' } },
], teamResourceSelections: [
  { purpose: { consumer, purpose: 'model-api' }, teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
] } };

describe('Connected Account private catalogs', () => {
  it('refuses source projection that would discard future secret carriers', () => {
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountServiceConfigurationsV1: {
      ...configuration.value, futureSecretId: 'future-secret',
    } }, 'configurations')).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: {
      ...purpose.value, futureSecretRef: 'future-secret',
    } }, 'purposes')).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
  it('refuses an unrecoverable earlier Team binding', () => {
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: { v: 1, bindings: [{
      purpose: { consumer, purpose: 'native-api' }, target: { kind: 'team_resource',
        selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
    }] } }, 'purposes')).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
  it('retains full qualified configuration populations and adapter dictionaries while stripping only unknown stored fields', () => {
    const record = { ...configuration, extra: true, value: { ...configuration.value, extra: true,
      entries: Array.from({ length: 257 }, (_, index) => ({ ...configuration.value.entries[0], modeId: `mode-${index}`, extra: true,
        service: { ...service, extra: true } })) } };
    expect(ConnectedAccountCatalogRecordV1Schema.safeParse(record).success).toBe(false);
    const parsed = StoredConnectedAccountCatalogRecordV1Schema.parse(record);
    expect(parsed.key).toBe('configurations');
    if (parsed.key !== 'configurations') throw new Error('Wrong fixture catalog');
    expect(parsed.value.entries).toHaveLength(257);
    expect(parsed.value.entries[256]).toEqual({ ...configuration.value.entries[0], modeId: 'mode-256' });
    expect(ConnectedAccountCatalogRecordV1Schema.parse(parsed)).toEqual(parsed);
    const refs = listConnectedConfigurationCatalogSavedSecretRefsV1(configuration.value);
    expect(refs).toEqual([{ path: 'entries[0].secretRefs.token', secretId: 'secret-old' }]);
    expect(rewriteConnectedConfigurationCatalogSavedSecretRefsV1(configuration.value, 'secret-old', 'secret-new'))
      .toEqual({ ...configuration.value, entries: [{ ...configuration.value.entries[0], secretRefs: { token: 'secret-new' } }] });
  });

  it('preserves Team resource defaults and rejects duplicate authority and earlier Team targets at current write admission', () => {
    expect(ConnectedAccountCatalogRecordV1Schema.parse(purpose)).toEqual(purpose);
    expect(ConnectedAccountCatalogRecordV1Schema.safeParse({ ...purpose, value: { ...purpose.value,
      bindings: [...purpose.value.bindings, { ...purpose.value.bindings[0], purpose: purpose.value.teamResourceSelections![0]!.purpose }] } }).success).toBe(false);
    expect(ConnectedAccountCatalogRecordV1Schema.safeParse({ key: 'purposes', value: { v: 1, bindings: [{
      purpose: { consumer, purpose: 'native-api' }, target: { kind: 'team_resource', teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
    }] } }).success).toBe(false);
  });

  it('opens a full retained purpose population without an earlier write-only collection ceiling', () => {
    const value = { v: 1 as const, bindings: Array.from({ length: 257 }, (_, index) => ({
      purpose: { consumer, purpose: `purpose-${index}` }, target: { kind: 'group' as const, service, groupId: 'pool' },
    })) };
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: value }, 'purposes'))
      .toEqual({ status: 'ready', record: { key: 'purposes', value } });
  });

  it.each([configuration, purpose])('opens keyless Plain and bound E2EE without crossing domain identity (%s)', record => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(21) };
    for (const mode of ['plain', 'e2ee'] as const) {
      const content = sealConnectedAccountCatalogContentV1({ record, mode, material: mode === 'plain' ? null : material });
      expect(openConnectedAccountCatalogContentV1({ key: record.key, content, mode, material: mode === 'plain' ? null : material }))
        .toEqual({ status: 'opened', record });
      expect(openConnectedAccountCatalogContentV1({ key: record.key === 'purposes' ? 'configurations' : 'purposes', content, mode,
        material: mode === 'plain' ? null : material }).status).toBe('unavailable');
      expect(openConnectedAccountCatalogContentV1({ key: record.key, content, mode: mode === 'plain' ? 'e2ee' : 'plain', material: null }).status)
        .toBe('unavailable');
    }
  });

  it('admits first authority only with source currentness and normal paired edits only with row currentness', () => {
    const content = { t: 'plain', v: purpose };
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 'absent', content }).success).toBe(false);
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 'absent', sourceSettingsVersion: 3, content }).success).toBe(true);
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 2, content,
      settingsMutation: { expectedSettingsVersion: 4, content: { t: 'plain', v: { futurePreference: 'preserve' } } } }).success).toBe(true);
  });

  it('never activates malformed source, reseeds tombstones, or publishes a receipt without admitted readback', async () => {
    let row: 'absent' | 'winner' = 'absent';
    const original = { connectedAccountServiceConfigurationsV1: { v: 1, entries: [{ modeId: 'invalid' }] }, future: 'preserve' };
    let writes = 0;
    const base = { key: 'configurations' as const, mode: 'plain' as const, material: null,
      readRow: async () => row === 'absent' ? { status: 'absent' as const } : { status: 'present' as const, revision: 8,
        content: sealConnectedAccountCatalogContentV1({ record: configuration, mode: 'plain', material: null }) },
      transfer: { readSourceSnapshot: async () => ({ raw: original, version: 3 }), initializeRecord: async () => {
        writes++; return { status: 'updated' as const, revision: 0, cursor: 0 };
      } },
    };
    expect(await loadConnectedAccountCatalogV1(base)).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(writes).toBe(0);
    const valid = { ...base, transfer: { ...base.transfer, readSourceSnapshot: async () => ({ raw: {}, version: 3 }) } };
    expect(await loadConnectedAccountCatalogV1(valid)).toEqual({ status: 'unavailable', reason: 'authority-not-confirmed' });
    row = 'winner';
    expect(await loadConnectedAccountCatalogV1(base)).toMatchObject({ status: 'ready', revision: 8, record: configuration,
      cleanup: { status: 'cleanup-pending' } });
    expect(writes).toBe(1);
    expect(await loadConnectedAccountCatalogV1({ ...base, readRow: async () => ({ status: 'deleted', revision: 9 }) }))
      .toMatchObject({ status: 'ready', revision: 9, record: { key: 'configurations', value: { v: 1, entries: [] } } });
    expect(writes).toBe(1);
  });
});
