import { expect, it } from 'vitest';
import { managedDataConnections, managedDataLinkContent, managedDataTargets } from './managedData';
import { definePlugin, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
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
      run: async () => ({}) }, delete: { title: 'Delete project', surfaces: ['ui'], execution: { target: 'account',
        account: { artifactId: 'account-runtime', exportName: 'activate' } }, dangerLevel: 'destructive', readOnly: false,
        confirmation: { title: 'Delete project?' }, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.delete'].jsonSchema,
        resultSchema: DeploymentTargetRoleResultV1ProtocolSchema, run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1, providerResourceAbsent: true } as const) },
      observe: { title: 'Observe project', surfaces: ['ui'], execution: { target: 'account',
        account: { artifactId: 'account-runtime', exportName: 'activate' } }, dangerLevel: 'safe', readOnly: true,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.observe'].jsonSchema,
        resultSchema: DeploymentTargetRoleResultV1ProtocolSchema, run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1, providerResourceAbsent: true } as const) } },
    deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { projects: { delete: 'delete', observe: 'observe' }, connectionSecret: { save: 'save' } } } } });
  const manifest = PluginPortableReleaseManifestV1Schema.parse(plugin.manifest);
  const [target] = managedDataTargets([{ manifest }]);
  expect(target?.targetId).toBe('database');
  expect(target?.teardown).toBe(true);
  // The provider's own words say what its delete takes with the project.
  expect(target?.teardownConsequence).toBe('Delete project?');
  const [withoutDeletion] = managedDataTargets([{ manifest: { ...manifest, contributes: { ...manifest.contributes,
    deploymentTargets: manifest.contributes.deploymentTargets?.map(descriptor => descriptor.role === 'data'
      ? { ...descriptor, dataV1: {} } : descriptor) } } }]);
  expect(withoutDeletion?.targetId).toBe('database');
  expect(withoutDeletion).not.toHaveProperty('teardown');
  expect(target?.operations[0]).toMatchObject({ role: 'connectionSecret.save',
    actionId: 'com.example.data/actions/save', credential: { purpose: 'manage', service } });
  expect(target?.operations[0]?.inputHints.fields.some(field => field.path === 'expectedRevision')).toBe(false);
  expect(target?.operations.map(operation => operation.role)).toEqual(['connectionSecret.save']);
});

it('keeps an ambiguous resource unlinked while exact provision/link identities remain recoverable', () => {
  // Creation provenance is authored by the host, never by client-supplied provider results.
  expect(managedDataLinkContent(principal, { state: 'provisioned', providerResourceOrigin: 'created', providerIdentity: identity,
    providerEnvironment: { kind: 'custom', id: 'main' } })).toEqual({ credentialPrincipal: principal,
    providerIdentity: identity, providerEnvironment: { kind: 'custom', id: 'main' } });
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

// P45 §3.2: native engine and provider-console facts survive association.
it('captures produced database presentation on the existing protected link without inventing missing facts', () => {
  const produced = { state: 'provisioned', providerIdentity: identity, providerEnvironment: { kind: 'custom', id: 'main' },
    engine: 'postgres', engineVersion: 17, providerConsole: { url: 'https://console.example.test/project', label: 'Open console' } };
  expect(managedDataLinkContent(principal, produced)).toMatchObject({ data: { engine: 'postgres', version: '17', providerConsole: produced.providerConsole } });
  expect(managedDataLinkContent(principal, { ...produced, engineVersion: undefined, providerConsole: undefined })).toMatchObject({ data: { engine: 'postgres' } });
  expect(managedDataLinkContent(principal, { ...produced, engine: undefined })).not.toHaveProperty('data');
});
