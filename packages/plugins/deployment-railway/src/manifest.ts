import { definePlugin, type DefinePluginInput } from '@happier-dev/plugin-sdk';
import { PluginError, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { createDeploymentTargetOptionsResource, type PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { RAILWAY_ORIGIN } from '@happier-dev/railway-api';
import { actionIds, closed, deleteAction, deleteActionId, engineActions, execution, networkAccess, observeRemovalAction, observeRemovalActionId, text, workflowAction, workflowActionId } from './actions.js';
import { railwayDatabaseRuntime } from './database.js';
import { ACCOUNT_PURPOSE, engines, nativeSelectorSchema, pluginId, railwayAccount, type Engine } from './provider.js';

const engineIds = Object.keys(engines) as Engine[];
const empty = closed({});
const resourceId = (actionId: string) => actionId + '-resource';
const forEngines = <T>(build: (engine: Engine) => readonly (readonly [string, T])[]): Record<string, T> =>
  Object.fromEntries(engineIds.flatMap(build));

export const plugin = definePlugin({
  id: pluginId, version: '0.0.0', displayName: 'Railway databases',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [
    { id: networkAccess, capability: 'network', reason: 'Read Railway database services and apply approved changes.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: RAILWAY_ORIGIN }], methods: ['POST'] } },
    { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Railway Account.',
      scope: { serviceRefs: [railwayAccount], operations: ['use'],
        materializationKinds: ['httpHeaders', 'environment'] } },
  ], optional: [] },
  actions: { ...forEngines(engine => Object.entries(engineActions(engine))),
    [workflowActionId]: workflowAction, [deleteActionId]: deleteAction, [observeRemovalActionId]: observeRemovalAction },
  resources: forEngines<NonNullable<DefinePluginInput['resources']>[string]>(engine => {
    const ids = actionIds(engine);
    const common = { source: 'dynamic', kind: 'config', scope: 'global', execution, contentType: 'application/json' } as const;
    const list: PluginDynamicResourceRuntime = {
      async read({ context, signal, readAction }) {
        if (context.kind !== 'surface') throw new PluginError({ code: 'deployment_unavailable' });
        const result = await readAction({ pluginId, localId: ids.list }, context.launchInput, { signal });
        if (!result.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'errorCode' in result && typeof result.errorCode === 'string'
          ? result.errorCode : 'deployment_unavailable' }),
          { phase: 'deployment.railway.data.list', causeKind: 'native_failure', error: result });
        return JSON.stringify(result.result);
      },
      async observe() { return { dispose() {} }; },
    };
    return [
      [resourceId(ids.options), { ...common, runtime: createDeploymentTargetOptionsResource({ pluginId, localId: ids.options },
        'deployment.railway.data.options', draft => ({
          ...(typeof draft.workspaceId === 'string' ? { workspaceId: draft.workspaceId } : {}),
          ...(typeof draft.projectId === 'string' ? { projectId: draft.projectId } : {}),
          ...(typeof draft.railwayEnvironmentId === 'string' ? { railwayEnvironmentId: draft.railwayEnvironmentId } : {}),
        })) }],
      [resourceId(ids.list), { ...common, scope: 'surface' as const, runtime: list }],
    ];
  }),
  inputTypes: forEngines<NonNullable<DefinePluginInput['inputTypes']>[string]>(engine =>
    (['workspace', 'project', 'environment', 'service'] as const).map(kind => [`${engine}-${kind}`, {
      title: `Railway ${kind}`, semantic: `railway-data-${engine}-${kind}`, valueSchema: text,
      options: { resource: resourceId(actionIds(engine).options) },
    }])),
  deploymentTargets: forEngines<NonNullable<DefinePluginInput['deploymentTargets']>[string]>(engine => {
    const ids = actionIds(engine);
    return [[engine, { role: 'data', title: `Railway ${engines[engine].label}`, icon: 'server-outline',
      targetKind: 'railway-' + engine, targetSchema: empty, linkSchema: empty, nativeSelectorSchema,
      dataV1: { database: { engineId: engine, runtime: railwayDatabaseRuntime(engine) },
        projects: { list: resourceId(ids.list), listAction: ids.list, provision: ids.provision, link: ids.link, delete: deleteActionId, observe: observeRemovalActionId } },
    }]];
  }),
});
export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
