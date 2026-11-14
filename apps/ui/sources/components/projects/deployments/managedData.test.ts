import { expect, it } from 'vitest';
import { managedDataConnections, managedDataLinkContent, managedDataTargets } from './managedData';
import { definePlugin, DeploymentTargetRoleInputProtocolSchemasV1 } from '@happier-dev/plugin-sdk';
import type { DeploymentTargetCredentialPrincipalV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';

const principal: DeploymentTargetCredentialPrincipalV1 = { kind: 'account', accountId: 'owner',
  purpose: { consumer: { pluginId: 'com.example.data', localId: 'link' }, purpose: 'manage' },
  target: { kind: 'account', account: { service: { pluginId: 'com.example.data', localId: 'account' }, accountId: 'token' } } };
const identity = { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' };

it('projects a data descriptor, its credential purpose and authored fields without a host provider catalog', () => {
  const service = { pluginId: 'com.example.credentials', localId: 'database' };
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const plugin = definePlugin({ id: 'com.example.data', version: '1.0.0', displayName: 'Database',
    hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts', reason: 'Manage the selected database',
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
    actions: { save: { title: 'Save connections', surfaces: ['ui'], execution: { target: 'account',
      account: { artifactId: 'account-runtime', exportName: 'activate' } }, dangerLevel: 'writesLocal', readOnly: false,
      confirmation: { title: 'Save these database connections?' },
      hostAccess: ['manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }],
      inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['connectionSecret.save'].jsonSchema, resultSchema: closed,
      run: async () => ({}) } },
    deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { connectionSecret: { save: 'save' } } } } });
  const [target] = managedDataTargets([{ manifest: PluginPortableReleaseManifestV1Schema.parse(plugin.manifest) }]);
  expect(target?.operations[0]).toMatchObject({ role: 'connectionSecret.save',
    actionId: 'com.example.data/actions/save', credential: { purpose: 'manage', service } });
  expect(target?.operations[0]?.inputHints.fields.some(field => field.path === 'expectedRevision')).toBe(false);
});

it('keeps an ambiguous resource unlinked while exact provision/link identities remain recoverable', () => {
  expect(managedDataLinkContent(principal, { state: 'provisioned', providerIdentity: identity,
    providerEnvironment: { kind: 'custom', id: 'main' } })).toEqual({ credentialPrincipal: principal,
    providerIdentity: identity, providerEnvironment: { kind: 'custom', id: 'main' } });
  expect(managedDataLinkContent(principal, { status: 'outcome_unknown', providerIdentity: identity,
    providerEnvironment: { kind: 'custom', id: 'main' } })).toBeNull();
});

it('retains only produced opaque connection refs across partial saves and a provision result', () => {
  const partial = { status: 'partial', connections: { DATABASE_URL: { ref: 'secret:pooled', resourceRevision: 3 } }, incomplete: ['DIRECT_URL'] };
  expect(managedDataConnections(partial)).toEqual([{ name: 'DATABASE_URL', ref: 'secret:pooled', resourceRevision: 3 }]);
  expect(managedDataConnections({ connectionSave: { ...partial, connections: { ...partial.connections,
    DIRECT_URL: { ref: 'secret:migrations', resourceRevision: 4 } } } })).toHaveLength(2);
});
