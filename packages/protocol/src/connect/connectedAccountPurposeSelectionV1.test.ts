import { describe, expect, it } from 'vitest';

import { PluginPortableReleaseManifestV1Schema } from '../plugins/availability/compatibilityProjectionV1.js';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '../plugins/availability/accountExecution.js';
import { readDeclaredConnectedAccountPurposeV1, resolveConnectedAccountPurposeDefaultTargetV1 } from './connectedAccountPurposeSelectionV1.js';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountGroupV4Schema } from './qualifiedConnectedAccountsV4.js';

describe('connected Account purpose declaration selection', () => {
  it('reads only the selected Account consumer Action host-access purposes without a Machine projection', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
      schemaVersion: 2, id: 'com.acme.account-purpose', version: '1.0.0', displayName: 'Account purpose',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [{ id: 'cloud-api', capability: 'connectedAccounts', reason: 'Read cloud data',
        scope: { serviceRefs: ['cloud-account', { pluginId: 'com.acme.other', localId: 'cloud-account' }], operations: ['use'] } },
      { id: 'unrelated-api', capability: 'connectedAccounts', reason: 'Another Action',
        scope: { serviceRefs: ['unrelated-account'], operations: ['use'] } }], optional: [] },
      contributes: { actions: [{ id: 'read-cloud', title: 'Read cloud', scopes: ['global'], surfaces: ['plugin'],
        dangerLevel: 'safe', execution: { target: 'account', account: { artifactId: 'account-main', exportName: 'activate' } },
        hostAccess: ['cloud-api'] }], resources: [{ id: 'cloud-resource', source: 'dynamic', kind: 'config',
          contentType: 'application/json', hostAccess: ['cloud-api'],
          execution: { target: 'account', account: { artifactId: 'account-main', exportName: 'activate' } } }] },
    });
    const accountSelection = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
      bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/account-purpose', manifest }) });
    if (accountSelection.kind !== 'available') throw new Error('The canonical Account selection must be available');
    const purpose = { consumer: { pluginId: manifest.id, localId: 'read-cloud' }, purpose: 'cloud-api' };
    expect(readDeclaredConnectedAccountPurposeV1({ purpose, accountSelection })).toEqual({ purpose: 'cloud-api',
      consumerKind: 'action', serviceRefs: [{ pluginId: manifest.id, localId: 'cloud-account' },
        { pluginId: 'com.acme.other', localId: 'cloud-account' }] });
    expect(readDeclaredConnectedAccountPurposeV1({ purpose: { ...purpose,
      consumer: { pluginId: manifest.id, localId: 'cloud-resource' } }, accountSelection })).toEqual({ purpose: 'cloud-api',
      consumerKind: 'resource', serviceRefs: [{ pluginId: manifest.id, localId: 'cloud-account' },
        { pluginId: 'com.acme.other', localId: 'cloud-account' }] });
    expect(readDeclaredConnectedAccountPurposeV1({ purpose: { ...purpose, purpose: 'unrelated-api' }, accountSelection })).toBeNull();
    expect(readDeclaredConnectedAccountPurposeV1({ purpose: { ...purpose,
      consumer: { pluginId: 'com.acme.foreign', localId: 'read-cloud' } }, accountSelection })).toBeNull();
  });

  it('admits an Account default for a declared system tool purpose only for its qualified service', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
      schemaVersion: 2, id: 'com.acme.forge', version: '1.0.0', displayName: 'Forge',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: { systemTools: [{ id: 'forge-cli', title: 'Forge CLI', executableNames: ['forge'],
        connectedAccountLaunch: { purpose: 'forge.cli', service: 'forge-account', environmentKey: 'FORGE_TOKEN' } }],
        connectedAccountDescriptors: [{ id: 'forge-account', title: 'Forge account', authentication: {
          defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] }] } }] },
    });
    const accountSelection = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
      bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/forge', manifest }) });
    if (accountSelection.kind !== 'available') throw new Error('Expected the admitted Account plugin');
    const purpose = { consumer: { pluginId: manifest.id, localId: 'forge-cli' }, purpose: 'forge.cli' };
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service: { pluginId: manifest.id, localId: 'forge-account' }, accountId: 'owner' }, status: 'connected',
      authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      configurationReady: true, configurationRevision: null, scopes: [],
    });
    const input = { declaration: { purpose, accountSelection }, target: { kind: 'account' as const, account: profile.ref },
      accounts: [profile], groups: [], now: 1 };
    expect(resolveConnectedAccountPurposeDefaultTargetV1(input)).toEqual(profile);

    const foreign = { ...profile, ref: { ...profile.ref, service: { ...profile.ref.service, pluginId: 'com.acme.other' } } };
    expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accounts: [foreign],
      target: { kind: 'account', account: foreign.ref } })).toBeNull();
    expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input,
      declaration: { ...input.declaration, purpose: { ...purpose, purpose: 'other.cli' } } })).toBeNull();
  });

  it('admits Account pool defaults using only the exact admitted service manifest authentication', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
      schemaVersion: 2, id: 'com.acme.pool', version: '1.0.0', displayName: 'Pool',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      hostAccess: { required: [{ id: 'cloud-api', capability: 'connectedAccounts', reason: 'Read cloud',
        scope: { serviceRefs: ['cloud-account', { pluginId: 'com.acme.external', localId: 'cloud-account' }], operations: ['use'] } }], optional: [] },
      contributes: { actions: [{ id: 'read-cloud', title: 'Read cloud', scopes: ['global'], surfaces: ['plugin'],
        dangerLevel: 'safe', execution: { target: 'account', account: { artifactId: 'main', exportName: 'activate' } }, hostAccess: ['cloud-api'] }],
        connectedAccountDescriptors: [{ id: 'cloud-account', title: 'Cloud', authentication: {
          defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] }] } }] },
    });
    const select = (selected: typeof manifest) => resolvePluginAccountExecutionSelectionV1({ pluginId: selected.id, intentRead: null,
      bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/pool', manifest: selected }) });
    const accountSelection = select(manifest);
    if (accountSelection.kind !== 'available') throw new Error('Expected admitted Account consumer');
    const external = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, id: 'com.acme.external' });
    const purpose = { consumer: { pluginId: manifest.id, localId: 'read-cloud' }, purpose: 'cloud-api' };
    for (const service of [{ pluginId: manifest.id, localId: 'cloud-account' }, { pluginId: external.id, localId: 'cloud-account' }]) {
      const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'owner' }, status: 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        configurationReady: true, configurationRevision: null, scopes: [] });
      const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'row',
        displayName: null, policy: {}, activeConnectedAccountId: 'owner', generation: 1, runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
        members: [{ v: 1, connectedAccountId: 'owner', enabled: true, priority: 1, state: {}, createdAt: 1, updatedAt: 1 }] });
      const input = { declaration: { purpose, accountSelection }, target: { kind: 'group' as const, service, groupId: 'work' },
        accounts: [profile], groups: [group], now: 1 };
      const accountServiceSelection = service.pluginId === manifest.id ? undefined : select(external);
      expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accountServiceSelection })).toEqual(profile);
      expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accountServiceSelection,
        readAuthentication: () => null })).toEqual(profile);
      if (accountServiceSelection) {
        expect(resolveConnectedAccountPurposeDefaultTargetV1(input)).toBeNull();
        expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accountServiceSelection: select(manifest) })).toBeNull();
        expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accountServiceSelection: select(
          PluginPortableReleaseManifestV1Schema.parse({ ...external, contributes: { ...external.contributes, connectedAccountDescriptors: [] } })) })).toBeNull();
      }
      const incompatible = { ...profile, authenticationModeId: 'undeclared-mode' };
      expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...input, accountServiceSelection, accounts: [incompatible] })).toBeNull();
    }
  });
});
