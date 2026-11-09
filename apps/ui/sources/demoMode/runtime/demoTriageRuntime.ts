import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentsBackendsListOutputSchema } from '@happier-dev/protocol/actions/agentBackendInventory';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { projectLaunchProfileListV1 } from '@happier-dev/protocol/profiles/listProjection';
import { readTriageActions, mutateTriageAction } from '../../../../../packages/plugins/triage/src/settings/actions';
import { TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1 } from '../../../../../packages/plugins/triage/src/sessions/actionResolution';
import { TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1 } from '../../../../../packages/plugins/triage/src/sessions/agentTarget';
import { PluginError, type JsonValue, type PluginReference } from '@happier-dev/plugin-sdk';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, SESSION_OPEN_ACTION_ID_V1, SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
    TRIAGE_DEFAULT_FIX_ACTION_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { buildDemoTriageWorld } from '../world/triage';
import { DEMO_NOW_MS, DEMO_MACHINE_ID, DEMO_PROJECT_PATH } from '../world/constants';
import { createDemoPluginTransport } from './demoPluginTransport';
import { createDemoPluginDataClient } from './demoPluginDataClient';
import { bindTriageDurableAccountV1 } from '../../../../../packages/plugins/triage/src/ui/durable/accountDurableState';
import { administerConfiguredSourceInstance } from '../../../../../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance';
import { listTriageEntries, type TriageAdmittedSourceV1 } from '../../../../../packages/plugins/triage/src/actions/listEntries';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import { TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/tasksProtocol';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../../../../packages/plugins/triage/src/internalTasks/contribution';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../../../../packages/plugins/triage/src/internalTasks/configuration';
import { createTriageSourceSessionRelations } from '../../../../../packages/plugins/triage/src/sessions/sourceSessionRelations';
import { readTriageEntryDetail } from '../../../../../packages/plugins/triage/src/actions/readEntryDetail';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/entryDetailProtocol';
import { readTriageActionsForSurface } from '../../../../../packages/plugins/triage/src/actions/actionsCatalog';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TriageReadActionsInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol';
import { readTriageSavedViewsForSurface } from '../../../../../packages/plugins/triage/src/actions/savedViews';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, TriageReadSavedViewsInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/savedViewsProtocol';
import { listTriagePinnedEntries } from '../../../../../packages/plugins/triage/src/actions/userMarks';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, TriageListPinnedEntriesInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/userMarksProtocol';
import { createTriageStartEntrySessionActionHandler } from '../../../../../packages/plugins/triage/src/actions/entrySession';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1, TriageStartEntrySessionInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import { createTriageReobserveEntryActionHandler } from '../../../../../packages/plugins/triage/src/actions/reobserveEntry';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/reobserveEntryProtocol';
import { createTriageRunConfiguredActionHandler } from '../../../../../packages/plugins/triage/src/actions/configuredActionRun';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema } from '../../../../../packages/plugins/triage/src/actions/mountedUiProtocol';
import { invokeTriageMountedUiAction } from '../../../../../packages/plugins/triage/src/ui/mountedActions';
import { createDemoPluginSessionTransport } from './demoPluginSessions';
import { TRIAGE_DISPLAY_NAME } from '../../../../../packages/plugins/triage/src/displayName';

/** Real Triage owners with only daemon observations and Account storage substituted. */
export function createDemoTriageRuntime(surface: SurfaceContext, options?: Readonly<{
    openSession(sessionId: string): Promise<void>;
}>) {
    const world = buildDemoTriageWorld();
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const scans = new Map<object, (typeof world)[number] | null>();
    const gets = new Map<object, (typeof world)[number] | null>();
    function admittedSource(source: { pluginId: string; localId: string }, descriptor: (typeof world)[number]['descriptor'], item: (typeof world)[number] | null) {
        const scan = {};
        const get = {};
        scans.set(scan, item);
        gets.set(get, item);
        // Opaque daemon handles originate at this substituted transport boundary; internal scan/fold logic stays real.
        return { contributor: { pluginId: source.pluginId, contributionId: source.localId }, protocol,
            descriptor, operations: { listInstances: {}, scan, get }, surfaces: {} } as unknown as TriageAdmittedSourceV1;
    }
    const admitted = [...world.map(item => admittedSource(item.source, item.descriptor, item)),
        admittedSource(INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source, INTERNAL_TASK_DESCRIPTOR_V1, null)];
    const targetedContributions: NonNullable<SurfaceContext['targetedContributions']> = {
        target: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, occurrenceId: 'demo-triage',
            sourceCustody: { kind: 'development', registeredRootId: 'demo-world' } },
        points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol,
            contributions: admitted.map(source => ({ contributor: source.contributor, protocol, descriptor: source.descriptor,
                operations: [], surfaces: [] })) }] }],
    };
    const host = createDemoPluginTransport({ pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, surface, executeAction });
    const dataClient = createDemoPluginDataClient({ pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, accountLifetime: host.accountLifetime });
    const durable = bindTriageDurableAccountV1(dataClient);
    const collections = durable.collections;
    if (!collections || !durable.actions || !durable.savedViews) throw new Error('Demo Account data is unavailable');
    const actions = durable.actions;
    const savedViews = durable.savedViews;
    // This configured Account profile explicitly selects the existing demo
    // checkout. Triage's normal placement/checkout owners still resolve it.
    const agentTarget = listAgentExecutionTargetsV1(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude)[0]!;
    const targetKey = buildBackendTargetKeyV2(agentTarget);
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'demo-triage-workspace', name: 'Workspace',
        preferredAgentTargetKey: targetKey, placement: { fixed: { serverId: host.accountLifetime.scope.serverId,
            machineId: DEMO_MACHINE_ID }, directory: DEMO_PROJECT_PATH }, checkout: 'reuse_workspace',
        createdAt: DEMO_NOW_MS, updatedAt: DEMO_NOW_MS });
    const agentInventory = AgentsBackendsListOutputSchema.parse({ items: [{ targetKey, label: 'Claude Code',
        agentId: 'claude', enabled: true, identity: agentTarget.identity, agentTarget }], defaultTargetKey: targetKey });
    const configuredActions = (async () => {
        const read = await readTriageActions({ catalog: actions });
        const fix = read.value.actions.find(action => action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1)!;
        const mutation = await mutateTriageAction({ catalog: actions, mintActionId: () => crypto.randomUUID() }, {
            kind: 'update', expectedRevision: read.revision, actionId: fix.actionId, label: fix.label,
            enabled: fix.enabled, appliesTo: fix.appliesTo, workspaceMode: fix.workspaceMode, profileId: profile.id,
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        });
        if (mutation.status !== 'applied') throw new Error('Demo Fix configuration could not be seeded');
    })();
    const ready = Promise.all([configuredActions, ...world.map(item => administerConfiguredSourceInstance({ collections, source: item.source,
        declaredPurpose: item.purpose, request: { kind: 'create', draft: {
            v: 1, binding: { purpose: item.purpose, account: { service: item.service, accountId: 'demo-display-account' } },
            localInstanceKey: item.source.localId, keyStability: 'stable',
            configuration: { v: 1, token: JSON.stringify({ fixture: item.sourceInstanceId }) },
            locator: { v: 1, displayLabel: item.snapshot.scopeLabel },
        } }, nowMs: DEMO_NOW_MS, mintSourceInstanceId: () => item.sourceInstanceId,
    }))]);
    // Only the admitted-registry and daemon Action transports are replaced here.
    const sessionTransport = createDemoPluginSessionTransport({ pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        attachmentTypeLabel: TRIAGE_DISPLAY_NAME,
        lifetime: host.accountLifetime, openSession: options?.openSession ?? (async () => { throw new PluginError({ code: 'unavailable' }); }) });
    const relationContext = { signal: host.signal, ui: host.api, accountScope: host.accountLifetime.scope, services: {
        storage: { account: { collection: dataClient.collection, kv: dataClient.accountKv } },
        targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: admitted }), dispose() {} }) },
        actions: { execute: executeAction, executeAdmittedTargetedOperation: async (operation: object) => {
            const item = gets.get(operation);
            if (item === undefined || item === null) throw new PluginError({ code: 'unavailable', message: 'This source operation has no demo observation.' });
            return { kind: 'present', localRef: item.localRef, locator: item.locator, snapshot: item.snapshot,
                viewer: item.viewer, sourceUpdatedAtMs: item.sourceUpdatedAtMs };
        } },
    } } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0];
    const sourceRelations = createTriageSourceSessionRelations(relationContext, collections);

    async function executeAction(reference: PluginReference, input: JsonValue): Promise<unknown> {
        await ready;
        const action = typeof reference === 'string' ? reference : reference.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 ? reference.localId : null;
        if (action === TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1) return projectLaunchProfileListV1([profile], { agentIds: ['claude'] });
        if (action === TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1) return agentInventory;
        if (action === SESSION_SPAWN_NEW_ACTION_ID_V1 || action === SESSION_OPEN_ACTION_ID_V1 || action === SESSION_MESSAGE_SEND_ACTION_ID_V1) return sessionTransport(action, input);
        if (action === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) return createTriageStartEntrySessionActionHandler()(TriageStartEntrySessionInputV1Schema.parse(input), relationContext);
        if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) return createTriageReobserveEntryActionHandler()(TriageReobserveEntryInputV1Schema.parse(input), relationContext);
        if (action === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1) return createTriageRunConfiguredActionHandler()(input, relationContext);
        if (action === TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1) {
            const parsed = TriageMountedUiInputV1Schema.parse(input);
            return host.ephemeralSharedScope === null ? { status: 'unavailable' } : invokeTriageMountedUiAction(host.ephemeralSharedScope, parsed.mountId, parsed.operation, host.signal);
        }
        if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 || action === TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1) {
            return listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
                sourceInstances: collections!.sourceInstances, readAdmittedSources: async () => admitted,
                executeScan: async operation => {
                    const item = scans.get(operation);
                    if (item === undefined) throw new Error('Unknown demo scan handle');
                    return { kind: 'complete', evidence: { kind: 'walkFinished' }, observations: item === null ? [] : [{
                        kind: 'present', localRef: item.localRef, locator: item.locator, snapshot: item.snapshot,
                        viewer: item.viewer, sourceUpdatedAtMs: item.sourceUpdatedAtMs,
                    }] };
                }, nowMs: () => DEMO_NOW_MS, taskOnly: action === TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1,
            });
        }
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return listTriagePinnedEntries(TriageListPinnedEntriesInputV1Schema.parse(input), { collections: collections!, nowMs: () => DEMO_NOW_MS });
        if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) return readTriageActionsForSurface(TriageReadActionsInputV1Schema.parse(input), { catalog: actions });
        if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) return readTriageSavedViewsForSurface(TriageReadSavedViewsInputV1Schema.parse(input), { catalog: savedViews, mintViewId: () => crypto.randomUUID() });
        if (action === TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1) {
            const parsed = TriageReadSourceSessionLinksInputV1Schema.parse(input);
            return 'entries' in parsed ? { kind: 'entries', entries: await sourceRelations.readEntries(parsed.entries) } : sourceRelations.read(parsed);
        }
        if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) return readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(input), { sourceRelations, readSessionSummary: async () => null });
        throw new PluginError({ code: 'unavailable', message: 'This Action has no demo transport.' });
    }
    return { host, dataClient, targetedContributions, ready, world };
}
