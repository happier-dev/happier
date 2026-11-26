import { deploymentTargetRoleWithNativeSelectorV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { nativeSelectorSchema, resultSchema as supabaseDataResultSchema } from '../../../../packages/plugins/deployment-supabase/src/data/schemas';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';

export async function installCopyDataProvider(input: Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    happyHomeDir?: string;
    controller?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['controller'];
}>) {
    const { credentials, serverId, serverHttpBaseUrl, machineId, happyHomeDir, controller } = input;
    const pluginId = 'example.copy-data';
    const account = { service: { pluginId, localId: 'service' }, accountId: 'fresh-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    const connectedAccounts = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => bindings, update: async mutate => (bindings = mutate(bindings)), subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('The author already selected a fresh account'); },
        resolveTarget: async target => target.kind === 'account' ? { displayName: 'Fresh account', account: target.account } : null,
        materializeAccount: async () => { throw new Error('This provider fixture uses no secret headers'); },
        materializeNative: async () => { throw new Error('This provider has no native credentials'); },
        projectTargetAccounts: async () => { throw new Error('No account enumeration'); },
        assertTargetAccountMaterializable: async () => {},
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        controller, happyHomeDir,
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
        })),
        runtimeOptions: { resolveCurrentMachineId: () => machineId, connectedAccounts, actionFormConnectedAccounts: connectedAccounts,
            deploymentAccountExecution: { credentials, serverUrl: serverHttpBaseUrl, serverId, serverIdentityId: serverId,
                machineId, isCurrent: async () => true } },
        plugins: [{ manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Copy data fixture',
            entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts',
                reason: 'Use the explicitly selected account', scope: { serviceRefs: ['service'], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
            contributes: {
                connectedAccountDescriptors: [{ id: 'service', title: 'Provider', authentication: { defaultModeId: 'manual', modes: [{
                    id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                }] } }],
                actions: [{ id: 'provision', title: 'Create database', scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], placementBindings: [],
                    execution: { target: 'daemon' }, hostAccess: ['manage'], dangerLevel: 'writesRemote',
                    confirmation: { title: 'Create the selected database?' },
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }],
                    inputSchema: deploymentTargetRoleWithNativeSelectorV1(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema, nativeSelectorSchema),
                    resultSchema: supabaseDataResultSchema('projects-provision'),
                }],
                deploymentTargets: [{ id: 'database', role: 'data', title: 'Database', icon: 'database', targetKind: 'postgres',
                    targetSchema: { type: 'object', properties: {}, additionalProperties: false },
                    linkSchema: { type: 'object', properties: {}, additionalProperties: false }, nativeSelectorSchema, dataV1: { projects: { provision: 'provision' } },
                }],
            },
        }, files: { 'daemon.mjs': `export function activate(api) {
            api.actions.register('provision', async input => {
                const response = await fetch('https://copy-provider.test/projects', { method: 'POST', body: JSON.stringify(input) });
                return await response.json();
            });
            api.connectedAccounts.register('service', {
                authentication: { modes: { manual: { kind: 'manual', async complete() { return { status: 'connected', displayName: 'Provider', scopes: [] }; } } } },
                async status() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                async refresh() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async materialize() { throw new Error('No credential disclosure'); },
            });
        }` } }],
    });
    return { runtime, pluginId, account };
}
