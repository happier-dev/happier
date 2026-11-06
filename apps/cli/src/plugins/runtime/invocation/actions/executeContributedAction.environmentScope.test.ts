import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { configuration } from '@/configuration';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from './createCommittedContributedActionDeps';

// Credential persistence and Home HTTP are external boundaries. Authored
// admission, activation, registry, approval policy and execution stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('consumes template Environment approval through the committed authored Action runtime', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const action = { pluginId: 'example.environment-approval', localId: 'publish' };
    const actionId = formatQualifiedPluginActionId(action);
    const template = createDeploymentEnvironmentHeaderV1({ serverId: 'srv_home' });
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: 'srv_home', id: 'preview-child', purpose: 'preview',
        previewTemplateEnvironmentId: template.id, previewRepositoryId: 'source-app', previewPullRequestId: 'pr-42', previewTargetLinkId: 'template-link' });
    let effects = 0;
    let prompts = 0;
    const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${environment.id}`);
        return { status: 200, data: { ok: true, environment, targetLinks: [] } };
    });
    const plugin = definePlugin({ id: action.pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { publish: { title: 'Publish preview', scopes: ['global'], surfaces: ['cli'],
            dangerLevel: 'writesRemote', approvalScope: 'environment',
            confirmation: { title: 'Publish preview status?' },
            inputSchema: { type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
                required: ['serverId', 'environmentId'], additionalProperties: false },
            resultSchema: { type: 'object', properties: { published: { type: 'boolean' } }, required: ['published'], additionalProperties: false },
            run: async () => { effects += 1; return { published: true }; },
        } },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
        runtimeOptions: { scopedActionRuntime: { credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-A' })).toString('base64url')}.signature`, encryption: null },
            actionsSettingsProvider: createActionSettingsProvider() }, resolveCurrentMachineId: () => 'machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'machine' }) },
    });
    try {
        const projection = buildPluginProjectionV2({ registry: fixture.registry.contributes,
            generation: fixture.registry.generation });
        const projectionKey = buildQualifiedPluginContributionKey(createPluginContributionIdentity(action));
        expect(projection.actionsById[projectionKey], JSON.stringify({ keys: Object.keys(projection.actionsById),
            actions: fixture.registry.contributes.actions.map(item => ({ pluginId: item.pluginId, id: item.definition.id })),
            occurrences: fixture.registry.contributes.occurrenceIdsByPluginId })).toMatchObject({ approvalScope: 'environment' });
        const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }) });
        const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
            admitAccount: async () => null, resolveRequestHeaders: async () => ({ Authorization: 'Bearer fixture-token' }),
            dispatchReceipt: async () => { throw new Error('Approval admission does not deploy'); } });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deployment, listContributedActionDefinitions: list,
            readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
            invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
                requestCurrentIntent: async () => { prompts += 1; return { status: 'rejected', code: 'plugin_action_current_intent_rejected' }; } }),
        });
        const scope = { kind: 'environment', environmentId: template.id } as const;
        let actionsSettings = normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{ actionId, scope,
            approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['cli'] }] });
        const invoke = () => {
            vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(actionsSettings));
            return executor.execute('action.invoke', { action, input: { serverId: 'srv_home', environmentId: environment.id } },
                { surface: 'cli', serverId: configuration.activeServerId, serverIdentityId: 'srv_home', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings });
        };
        expect(await invoke()).toEqual({ ok: true, result: { published: true } });
        expect(effects).toBe(1);
        expect(prompts).toBe(0);
        expect(http).toHaveBeenCalledTimes(1);
        actionsSettings = normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{ actionId, scope,
            approvalRequiredSurfaces: ['cli'], approvalWaivedSurfaces: [] }] });
        expect(await invoke()).toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
        expect(effects).toBe(1);
        expect(prompts).toBe(1);
        expect(http).toHaveBeenCalledTimes(2);
    } finally { await fixture.dispose(); }
});
