import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveDatabaseRequesterKindV1 } from '@happier-dev/databases';
import type { DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseActions } from './actions.js';
import { createManualDatabaseTargets } from './manualTargets.js';
import { createWorktreeDatabaseTargets } from './worktreeTargets.js';
import { createDatabaseConnectionResourceRuntime, DATABASE_CONNECTION_RESOURCE_ID_V1 } from './resources.js';
import { createDatabaseRuntime } from './runtime.js';
import { createDatabaseInsightProducers } from './insights/findings.js';
import { createDatabaseWorkbenchPlacements } from './ui/placements.js';
import { openWorkbenchActions } from './ui/surface/openWorkbench.js';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID, databaseFindingEvent,
    databaseFindingEventSetupAction } from './insights/events.js';
import {
    WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_RENDERER_ID, WORKBENCH_PAGE_VIEW_ID,
    WORKBENCH_PANEL_ARTIFACT_ID, WORKBENCH_PANEL_RENDERER_ID, WORKBENCH_PANEL_VIEW_ID,
    WORKBENCH_RAIL_ARTIFACT_ID, WORKBENCH_RAIL_RENDERER_ID,
} from './ui/surface/views.js';

const translationLocales = ['ca', 'de', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'] as const;
const translations = translationLocales.map(locale => ({ locale, resourceId: `i18n-${locale.toLowerCase()}` }));

function manualTargets(context: PluginInvocationContext) {
    return createManualDatabaseTargets({ storage: context.services.storage.daemon, identity: context,
        databaseEngines: context.services.databaseEngines });
}

const worktreeTargets = createWorktreeDatabaseTargets();
const worktreeRequest = (context: PluginInvocationContext) => ({ identity: context, storage: context.services.storage.daemon,
    requester: resolveDatabaseRequesterKindV1(context), databaseEngines: context.services.databaseEngines,
    worktreeEnvironment: context.services.worktreeEnvironment, signal: context.signal });

function deploymentTargets(context: Pick<PluginInvocationContext['services'], 'deploymentDatabases'>) {
    const service = context.deploymentDatabases;
    if (!service) throw new PluginError({ code: 'deployment_target_role_unavailable' });
    return service;
}

const runtime = createDatabaseRuntime({
    async listTargets(input, context) {
        if (input.scope.kind === 'environment') return deploymentTargets(context.services).listTargets(input);
        const discovered = await worktreeTargets.list({ input, ...worktreeRequest(context) });
        const manual = await manualTargets(context).list({ input, requester: resolveDatabaseRequesterKindV1(context), signal: context.signal });
        return { targets: [...discovered.targets, ...manual.targets], completeness: { complete: true } };
    },
    resolve({ input, context, access }) {
        if (isDeploymentTarget(input.target)) return deploymentTargets(context.services).resolve(input, access);
        if (input.target.kind === 'worktree') return worktreeTargets.resolve({ input, access, ...worktreeRequest(context) });
        return manualTargets(context).resolve({ input, access, requester: resolveDatabaseRequesterKindV1(context),
            secrets: context.services.secrets, signal: context.signal });
    },
    async admit({ input, context, access }) {
        if (isDeploymentTarget(input.target)) return deploymentTargets(context.services).admit(input, access);
        if (input.target.kind === 'worktree') return worktreeTargets.admit({ input, access, ...worktreeRequest(context) });
        return manualTargets(context).admit({ target: input.target, access, requester: resolveDatabaseRequesterKindV1(context),
            signal: context.signal });
    },
});

function isDeploymentTarget(target: DatabaseTargetV1): boolean {
    return target.kind === 'managed_deployment' || target.kind === 'deployment_service';
}

export const plugin = definePlugin({
    id: 'happier.database',
    version: '0.0.0',
    displayName: 'Database',
    entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    activation: { events: [] },
    serviceLaunchEnvironments: { 'database-discovery': {
        declaration: { environmentNames: [] }, runtime: worktreeTargets.launch,
    } },
    ui: {
        translations,
        views: [{
            // Databases on Dev servers, beside the services that use them.
            id: WORKBENCH_PANEL_VIEW_ID, container: 'servicesPanel', target: { kind: 'services' }, renderer: WORKBENCH_PANEL_RENDERER_ID,
            title: { key: 'plugins.database.section.title', fallback: 'Databases' },
        }, {
            // One database's tables, rows, structure and Console, opened from that section.
            id: WORKBENCH_PAGE_VIEW_ID, container: 'appPage', target: { kind: 'app' }, renderer: WORKBENCH_PAGE_RENDERER_ID,
            title: { key: 'plugins.database.page.title', fallback: 'Database' },
            description: { key: 'plugins.database.page.description', fallback: 'Browse tables, run SQL and review changes before they’re applied.' },
        }, ...createDatabaseWorkbenchPlacements({
            databaseRenderer: WORKBENCH_RAIL_RENDERER_ID,
            insightsRenderer: WORKBENCH_RAIL_RENDERER_ID,
        }),
        ],
        renderers: [{
            id: WORKBENCH_PANEL_RENDERER_ID, kind: 'reactNative', artifact: WORKBENCH_PANEL_ARTIFACT_ID,
            requiredHostMethods: ['executeAction', 'openSurface'],
        }, {
            id: WORKBENCH_PAGE_RENDERER_ID, kind: 'reactNative', artifact: WORKBENCH_PAGE_ARTIFACT_ID,
            requiredHostMethods: ['executeAction', 'actionControl', 'replacePageLocation', 'setUnsavedChanges', 'deviceState', 'notify'],
        }, {
            id: WORKBENCH_RAIL_RENDERER_ID, kind: 'reactNative', artifact: WORKBENCH_RAIL_ARTIFACT_ID,
            requiredHostMethods: ['executeAction', 'readResource', 'watchResource', 'openSurface', 'actionControl', 'setUnsavedChanges', 'deviceState', 'notify'],
        }],
    },
    events: { [DATABASE_FINDING_EVENT_REF.localId]: databaseFindingEvent },
    actions: { ...createDatabaseActions({
        ...runtime,
        ...createDatabaseInsightProducers({ executeOperation: runtime.executeOperation }),
        connectTarget(input, context) {
            return manualTargets(context).connect({ scope: input.scope, savedSecretId: input.savedSecretRef,
                label: input.label, agentAccess: 'read', secrets: context.services.secrets, signal: context.signal });
        },
        async readAccess(input, context) {
            if (isDeploymentTarget(input.target)) {
                const admitted = await deploymentTargets(context.services).admit({ operation: 'describe', target: input.target }, 'read');
                return { setBy: 'environment', serverId: admitted.environment.serverId,
                    environmentId: admitted.environment.environmentId, expectedRevision: admitted.environment.revision, access: admitted.access };
            }
            const admitted = input.target.kind === 'worktree'
                ? await worktreeTargets.admit({ input: { operation: 'describe', target: input.target }, access: 'read', ...worktreeRequest(context) })
                : await manualTargets(context).admit({ target: input.target, access: 'read',
                requester: resolveDatabaseRequesterKindV1(context), signal: context.signal });
            return { setBy: 'machine', agentAccess: admitted.agentAccess, access: admitted.access };
        },
        async setAccess(input, context) {
            const agentAccess = input.target.kind === 'worktree'
                ? await worktreeTargets.setAccess({ target: input.target, agentAccess: input.agentAccess, ...worktreeRequest(context) })
                : await manualTargets(context).setAccess({ target: input.target, agentAccess: input.agentAccess, signal: context.signal });
            return { ok: true, agentAccess };
        },
        async attachReadAccess(input, context) {
            const service = deploymentTargets(context.services);
            if (!service.attachReadAccess) throw new PluginError({ code: 'database_read_access_setup_unavailable' });
            return service.attachReadAccess(input);
        },
        async createReadAccess(input, context) {
            const service = deploymentTargets(context.services);
            if (!service.createReadAccess) throw new PluginError({ code: 'database_read_access_setup_unavailable' });
            return service.createReadAccess(input);
        },
        forgetTarget(input, context) {
            return manualTargets(context).forget({ target: input.target, signal: context.signal });
        },
    }), ...openWorkbenchActions, [DATABASE_FINDING_SETUP_LOCAL_ID]: databaseFindingEventSetupAction },
    resources: {
        ...Object.fromEntries(translations.map(({ locale, resourceId }) => [resourceId, {
            kind: 'asset' as const,
            path: `src/i18n/${locale}.json`,
            contentType: 'application/json',
        }])),
        [DATABASE_CONNECTION_RESOURCE_ID_V1]: {
            source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
            runtime: createDatabaseConnectionResourceRuntime({
                resolve(context) {
                    if (context.input.target.kind === 'managed_deployment' || context.input.target.kind === 'deployment_service') {
                        return deploymentTargets(context).resolve(context.input, 'read');
                    }
                    if (context.input.target.kind === 'worktree') return worktreeTargets.resolve({ input: context.input, access: 'read',
                        identity: context, storage: context.daemonStorage, requester: resolveDatabaseRequesterKindV1(context),
                        databaseEngines: context.databaseEngines, worktreeEnvironment: context.worktreeEnvironment, signal: context.signal });
                    return createManualDatabaseTargets({ storage: context.daemonStorage, identity: context, databaseEngines: context.databaseEngines }).resolve({
                        input: context.input, access: 'read', requester: resolveDatabaseRequesterKindV1(context),
                        secrets: context.secrets, signal: context.signal,
                    });
                },
            }),
        },
    },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
