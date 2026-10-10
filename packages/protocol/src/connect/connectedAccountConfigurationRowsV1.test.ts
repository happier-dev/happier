import { describe, expect, it } from 'vitest';
import {
  ConnectedAccountCatalogRecordV1Schema, ConnectedAccountCatalogRowMutationV1Schema,
  StoredConnectedAccountCatalogRecordV1Schema, sealConnectedAccountCatalogContentV1, openConnectedAccountCatalogContentV1,
  AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema, AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema,
  sealConnectedAccountCatalogMigrationContentV1,
  parseStoredConnectedAccountCatalogContentV1,
  listConnectedConfigurationCatalogSavedSecretRefsV1, rewriteConnectedConfigurationCatalogSavedSecretRefsV1,
  type ConnectedAccountCatalogRecordV1,
} from './connectedAccountConfigurationRowsV1.js';
import { loadConnectedAccountCatalogV1, readRetainedConnectedAccountCatalogRecordV1 } from './connectedAccountCatalogV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { connectedAccountCatalogCipherKindV1 } from './connectedAccountConfigurationRowsV1.js';
import type { AgentDefaultChoiceAgent } from './agentDefaultChoices.js';

const service = { pluginId: 'happier.connected-account.example', localId: 'cloud' };
const consumer = { pluginId: 'happier.agent.example', localId: 'coding' };
const oldRef = formatSharedSavedSecretRefV1('secret-old');
const newRef = formatSharedSavedSecretRefV1('secret-new');
const configuration: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [
  { service, modeId: 'native-api', revision: 'revision-1', values: { adapter: { arbitraryField: 'retained' } }, secretRefs: { token: oldRef } },
] } };
const purpose: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1, bindings: [
  { purpose: { consumer, purpose: 'native-api' }, target: { kind: 'group', service, groupId: 'pool' } },
], teamResourceSelections: [
  { purpose: { consumer, purpose: 'model-api' }, teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
] } };

describe('Connected Account private catalogs', () => {
  it.each([configuration, purpose])('retains complete original JSON for %s conversion without authoring permissive new rows', record => {
    const payload = { ...record, retainedWrapper: { color: 'blue' }, value: record.key === 'configurations'
      ? { ...record.value, retainedCatalog: { color: 'green' }, entries: record.value.entries.map(entry => ({ ...entry, retainedEntry: { color: 'red' } })) }
      : { ...record.value, retainedCatalog: { color: 'green' }, bindings: record.value.bindings.map(binding => ({ ...binding, retainedEntry: { color: 'red' } })) } };
    const plain = { t: 'plain' as const, v: payload, retainedEnvelope: { color: 'orange' } };
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(21) };
    for (const mode of ['plain', 'e2ee'] as const) {
      const content = mode === 'plain' ? plain : { t: 'encrypted' as const, retainedEnvelope: plain.retainedEnvelope,
        c: sealAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(record.key), material, payload,
          randomBytes: length => new Uint8Array(length).fill(9) }) };
      const input = { key: record.key, mode, material: mode === 'plain' ? null : material, content, admission: 'migration' as const };
      const opened = openConnectedAccountCatalogContentV1(input);
      expect(opened).toMatchObject({ status: 'opened', record,
        migrationSource: { content, payload } });
      if (opened.status !== 'opened') throw new Error('Complete retained conversion source required');
      const targetMode = mode === 'plain' ? 'e2ee' : 'plain';
      const converted = sealConnectedAccountCatalogMigrationContentV1({ source: opened.migrationSource,
        mode: targetMode, material: targetMode === 'plain' ? null : material, randomBytes: length => new Uint8Array(length).fill(7) });
      expect(converted.retainedEnvelope).toEqual(plain.retainedEnvelope);
      expect(openConnectedAccountCatalogContentV1({ key: record.key, mode: targetMode,
        material: targetMode === 'plain' ? null : material, content: converted, admission: 'migration' }))
        .toMatchObject({ status: 'opened', record, migrationSource: { content: converted, payload } });
      if (targetMode === 'plain') expect(converted).toEqual(plain);
      expect(openConnectedAccountCatalogContentV1({ ...input, content: { ...content, futureSecretId: oldRef } }).status).toBe('partial');
    }
    const directive = record.key === 'configurations' ? AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema
      : AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema;
    expect(directive.parse({ expectedRevision: 4, content: plain })).toEqual({ expectedRevision: 4, content: plain });
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 4, content: plain }).success).toBe(false);
  });
  it.each(['valid', 'native-only', 'missing-declarations', 'ambiguous-declarations', 'invalid-descriptor', 'malformed-source'] as const)(
    'admits purpose authority only after genuine scalar defaults migrate through catalog declarations (%s)', async scenario => {
      if (purpose.key !== 'purposes') throw new Error('Wrong fixture catalog');
      const codex = { pluginId: 'happier.agent.codex', localId: 'codex' };
      const codexService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const antigravity = { pluginId: 'happier.agent.antigravity', localId: 'antigravity' };
      const antigravityService = { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' };
      // The existing Agent-default projection supplies identity and purpose
      // declarations; raw predecessor Agent/service strings are not identities.
      const agents = [
        { agentId: 'codex', identity: codex, connectedAccounts: [{ purpose: 'model-openai', service: codexService }] },
        { agentId: 'antigravity', identity: antigravity, connectedAccounts: [{ purpose: 'model_upstream', service: antigravityService }] },
      ] satisfies readonly Pick<AgentDefaultChoiceAgent, 'agentId' | 'identity' | 'connectedAccounts'>[];
      const raw = { connectedAccountPurposeBindingsV1: purpose.value,
        connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: {
          'openai-codex': scenario === 'native-only' ? { source: 'native' }
            : { source: 'connected', selection: 'group', groupId: scenario === 'malformed-source' ? '' : 'codex-main' },
        } } } },
        connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { agy: { v: 1, bindingsByServiceId: {
          antigravity: scenario === 'native-only' ? { source: 'native' }
            : { source: 'connected', selection: 'profile', profileId: 'google-work' },
        } } } }, preferredLanguage: 'de' };
      const expected: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { ...purpose.value, bindings: [...purpose.value.bindings,
        { purpose: { consumer: codex, purpose: 'model-openai' }, target: { kind: 'group', service: codexService, groupId: 'codex-main' } },
        { purpose: { consumer: antigravity, purpose: 'model_upstream' }, target: { kind: 'account', account: { service: antigravityService, accountId: 'google-work' } } },
      ] } };
      let initialized: ConnectedAccountCatalogRecordV1 | undefined;
      const writes: Readonly<{ record: ConnectedAccountCatalogRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>[] = [];
      const result = await loadConnectedAccountCatalogV1({ key: 'purposes', mode: 'plain', material: null,
        readRow: async () => initialized ? { status: 'present', revision: 0, content: { t: 'plain', v: initialized } } : { status: 'absent' },
        transfer: { readSourceSnapshot: async () => ({ raw, version: 9,
          purposeDefaultAgents: scenario === 'missing-declarations' || scenario === 'native-only' ? null
            : scenario === 'ambiguous-declarations' ? [...agents, { ...agents[0]!, identity: { pluginId: 'external.shadow', localId: 'codex' } }]
              : scenario === 'invalid-descriptor' ? [{ ...agents[0]!, identity: null }, agents[1]!] : agents }),
        initializeRecord: async input => { writes.push(input); initialized = input.record; return { status: 'updated', revision: 0, cursor: 0 }; } },
      });
      if (scenario === 'valid' || scenario === 'native-only') {
        const admitted = scenario === 'native-only' ? purpose : expected;
        expect(writes).toEqual([{ record: admitted, expectedRevision: 'absent', sourceSettingsVersion: 9 }]);
        expect(result).toMatchObject({ status: 'ready', revision: 0, record: admitted });
      } else {
        expect(result).toEqual({ status: 'unavailable', reason: scenario === 'malformed-source' ? 'invalid-stored-content' : 'authority-not-confirmed' });
        expect(writes).toEqual([]);
      }
    },
  );
  it.each(['present', 'deleted'] as const)('never reactivates predecessor intent after a purpose row is %s', async status => {
    const malformedSource = { connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
      codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: '' } } },
    } } };
    let initializations = 0;
    const result = await loadConnectedAccountCatalogV1({ key: 'purposes', mode: 'plain', material: null,
      readRow: async () => status === 'present' ? { status: 'present', revision: 4, content: { t: 'plain', v: purpose } }
        : { status: 'deleted', revision: 4 },
      transfer: { readSourceSnapshot: async () => ({ raw: malformedSource, version: 9, purposeDefaultAgents: null }),
        initializeRecord: async () => { initializations++; return { status: 'updated', revision: 0, cursor: 0 }; } },
    });
    expect(result).toMatchObject({ status: 'ready', revision: 4,
      record: status === 'present' ? purpose : { key: 'purposes', value: { v: 1, bindings: [] } } });
    expect(initializations).toBe(0);
  });
  it.each(['plain', 'e2ee'] as const)('reads retained %s envelope metadata but denies outer reference authority', async mode => {
    const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(21) };
    const current = sealConnectedAccountCatalogContentV1({ record: purpose, mode, material });
    const retained = { ...current, futureMetadata: { retained: true } };
    expect(openConnectedAccountCatalogContentV1({ key: purpose.key, mode, material, content: retained }))
      .toEqual({ status: 'opened', record: purpose });
    expect(parseStoredConnectedAccountCatalogContentV1(retained)).toEqual(current);
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 4, content: retained }).success).toBe(false);
    const reference = { ...retained, futureSecretId: oldRef };
    const diagnostics = [{ path: 'content.futureSecretId', reason: 'unclassified-reference' }];
    expect(openConnectedAccountCatalogContentV1({ key: purpose.key, mode, material, content: reference }))
      .toEqual({ status: 'partial', record: purpose, diagnostics });
    expect(parseStoredConnectedAccountCatalogContentV1(reference)).toBeNull();
    let effects = 0;
    expect(await loadConnectedAccountCatalogV1({ key: purpose.key, mode, material,
      readRow: async () => ({ status: 'present', revision: 4, content: reference }),
      transfer: { readSourceSnapshot: async () => { effects++; return { raw: {}, version: 3 }; },
        initializeRecord: async () => { effects++; return { status: 'updated' as const, revision: 0, cursor: 0 }; } },
      onReadyBeforeCleanup: async () => { effects++; } }))
      .toEqual({ status: 'partial', authority: 'active', revision: 4, record: purpose, diagnostics });
    expect(effects).toBe(0);
  });
  it('keeps personal references only in the genuine retained source, never active Plain or E2EE authority', () => {
    if (configuration.key !== 'configurations') throw new Error('Wrong fixture catalog');
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(21) };
    for (const reference of ['personal-secret', 'happier:shared-secret:v1:']) {
      const record: ConnectedAccountCatalogRecordV1 = { ...configuration, value: { v: 1, entries: [
        configuration.value.entries[0]!, { ...configuration.value.entries[0]!, modeId: 'other-mode', secretRefs: { token: reference } },
      ] } };
      const diagnostics = [{ path: 'entries[1].secretRefs.token', reason: 'invalid-stored-content' }];
      for (const mode of ['plain', 'e2ee'] as const) {
        const content = mode === 'plain' ? { t: 'plain' as const, v: record } : { t: 'encrypted' as const,
          c: sealAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1('configurations'), material, payload: record,
            randomBytes: length => new Uint8Array(length).fill(9) }) };
        expect(openConnectedAccountCatalogContentV1({ key: 'configurations', mode, material: mode === 'plain' ? null : material, content }))
          .toEqual({ status: 'partial', record, diagnostics });
        expect(() => sealConnectedAccountCatalogContentV1({ record, mode, material: mode === 'plain' ? null : material })).toThrow();
      }
      expect(parseStoredConnectedAccountCatalogContentV1({ t: 'plain', v: record })).toBeNull();
      expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountServiceConfigurationsV1: record.value }, 'configurations'))
        .toEqual(reference === 'personal-secret' ? { status: 'ready', record } : { status: 'partial', record, diagnostics });
    }
  });
  it('diagnoses future source carriers without promoting a safe projection to complete authority', () => {
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountServiceConfigurationsV1: {
      ...configuration.value, futureSecretId: 'future-secret',
    } }, 'configurations')).toMatchObject({ status: 'partial', record: configuration,
      diagnostics: [{ path: 'futureSecretId', reason: 'unclassified-reference' }] });
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: {
      ...purpose.value, futureSecretRef: 'future-secret',
    } }, 'purposes')).toMatchObject({ status: 'partial', record: purpose,
      diagnostics: [{ path: 'futureSecretRef', reason: 'unclassified-reference' }] });
  });
  it('refuses an unrecoverable earlier Team binding', () => {
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: { v: 1, bindings: [{
      purpose: { consumer, purpose: 'native-api' }, target: { kind: 'team_resource',
        selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
    }] } }, 'purposes')).toMatchObject({ status: 'partial', record: { key: 'purposes', value: { v: 1, bindings: [] } },
      diagnostics: [{ path: 'bindings[0]', reason: 'invalid-stored-content' }] });
  });
  it('keeps original diagnostic positions while opening earlier Team selections beside current bindings', () => {
    const team = purpose.key === 'purposes' ? purpose.value.teamResourceSelections![0]! : null;
    if (!team || purpose.key !== 'purposes') throw new Error('Wrong fixture catalog');
    expect(readRetainedConnectedAccountCatalogRecordV1({ connectedAccountPurposeBindingsV1: { v: 1, bindings: [
      { purpose: team.purpose, target: { kind: 'team_resource', teamId: team.teamId, selection: team.selection } },
      purpose.value.bindings[0],
      { ...purpose.value.bindings[0], target: { kind: 'group', service, groupId: '' } },
    ] } }, 'purposes')).toEqual({ status: 'partial', record: purpose,
      diagnostics: [{ path: 'bindings[2]', reason: 'invalid-stored-content' }] });
  });
  it.each([configuration, purpose])('retains qualified safe neighbors for display while refusing incomplete authority (%s)', async record => {
    const rawRecord = record.key === 'configurations'
      ? { ...record, value: { ...record.value, entries: [...record.value.entries,
        { ...record.value.entries[0]!, modeId: '', secretRefs: {} }], futureSecretId: 'opaque' } }
      : { ...record, value: { ...record.value, bindings: [...record.value.bindings,
        { ...record.value.bindings[0]!, target: { kind: 'group' as const, service, groupId: '' } }], futureSecretId: 'opaque' } };
    const content = { t: 'plain' as const, v: rawRecord };
    const diagnostics = [
      { path: record.key === 'configurations' ? 'entries[1]' : 'bindings[1]', reason: 'invalid-stored-content' },
      { path: 'futureSecretId', reason: 'unclassified-reference' },
    ];
    expect(openConnectedAccountCatalogContentV1({ key: record.key, mode: 'plain', material: null, content }))
      .toEqual({ status: 'partial', record, diagnostics });
    expect(parseStoredConnectedAccountCatalogContentV1(content)).toBeNull();
    expect(ConnectedAccountCatalogRowMutationV1Schema.safeParse({ expectedRevision: 4, content }).success).toBe(false);
    let effects = 0;
    const transfer = { readSourceSnapshot: async () => { effects++; return { raw: {}, version: 3 }; },
      initializeRecord: async () => { effects++; return { status: 'updated' as const, revision: 0, cursor: 0 }; },
      replaceSource: async () => { effects++; return { status: 'applied' as const, settingsVersion: 4 }; },
      normalizeHistory: async () => { effects++; return { status: 'complete' as const }; } };
    expect(await loadConnectedAccountCatalogV1({ key: record.key, mode: 'plain', material: null,
      readRow: async () => ({ status: 'present', revision: 4, content }), transfer,
      onReadyBeforeCleanup: async () => { effects++; } })).toEqual({ status: 'partial', authority: 'active', revision: 4, record, diagnostics });
    expect(effects).toBe(0);
    expect(await loadConnectedAccountCatalogV1({ key: record.key, mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }), transfer: { ...transfer,
        readSourceSnapshot: async () => ({ raw: { [record.key === 'configurations'
          ? 'connectedAccountServiceConfigurationsV1' : 'connectedAccountPurposeBindingsV1']: rawRecord.value }, version: 3 }) },
      onReadyBeforeCleanup: async () => { effects++; } })).toEqual({ status: 'partial', authority: 'inactive', revision: 'absent', record, diagnostics });
    expect(effects).toBe(0);
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
    expect(refs).toEqual([{ path: 'entries[0].secretRefs.token', secretId: oldRef }]);
    expect(rewriteConnectedConfigurationCatalogSavedSecretRefsV1(configuration.value, oldRef, newRef))
      .toEqual({ ...configuration.value, entries: [{ ...configuration.value.entries[0], secretRefs: { token: newRef } }] });
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
    expect(await loadConnectedAccountCatalogV1(base)).toMatchObject({ status: 'partial', authority: 'inactive', revision: 'absent',
      diagnostics: [{ path: 'entries[0]', reason: 'invalid-stored-content' }] });
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
