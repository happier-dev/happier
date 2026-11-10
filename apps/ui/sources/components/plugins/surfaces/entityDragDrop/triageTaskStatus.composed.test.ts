import { expect, it } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginDragSourceContributionV1Schema, PluginDropTargetContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/entityDragDrop';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { TriageSourceDescriptorV1Schema, MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '@happier-dev/triage-protocol/v1';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginUiClientExecutableRegistrationIndex, resolvePluginUiClientDragSourceRegistration, resolvePluginUiClientDropTargetRegistration } from '../../reactNative/clientExecutableContributions';
import { createPluginEntityDragDropBinding, settlePluginEntityDropActionResult } from './pluginEntityDragDropBinding';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../../../../../../../packages/plugins/triage/src/manifest';
import { activate, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 } from '../../../../../../../packages/plugins/triage/src/ui/list/entryDragDrop';
import { assignTriageTaskStatusGroup } from '../../../../../../../packages/plugins/triage/src/ui/list/taskGroupMembership';
import { planTriageListItemsV1 } from '../../../../../../../packages/plugins/triage/src/ui/list/sections';
import { createTestkitCorpusCollections } from '../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../../../../../../packages/plugins/triage/src/internalTasks/contribution';
import { TriageListEntriesResultV1Schema, type TriageListEntriesResultV1 } from '../../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../../../../../../packages/plugins/triage/src/projection/listWindow';
import { laneObservationsFromWire } from '../../../../../../../packages/plugins/triage/src/projection/listWindowWire';
import { TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../../../../../../packages/plugins/triage/src/actions/tasksProtocol';

it.each([2, 2000])('releases a source-derived %i-row Collection status destination into one real transition Action and Account CAS, with agent parity and cancellation', async rowCount => {
    const scope = { serverId: 'home', accountId: 'account' };
    const rows = new Map<string, { value: unknown; version: number }>();
    const taskIds = ['a', 'b', ...Array.from({ length: rowCount - 2 }, (_, index) => `scale-${index}`)];
    const reset = () => {
        rows.set('todo.index', { value: { undoneOrder: taskIds, completedOrder: [] }, version: 1 });
        rows.set('todo.a', { value: { id: 'a', title: 'Finish the task', done: false, state: 'unstarted', createdAt: 1, updatedAt: 1 }, version: 1 });
        rows.set('todo.b', { value: { id: 'b', title: 'Work in progress', done: false, state: 'started', createdAt: 2, updatedAt: 2 }, version: 1 });
        for (const [index, id] of taskIds.slice(2).entries()) rows.set(`todo.${id}`, { value: {
            id, title: `Task ${index}`, done: false, state: 'unstarted', createdAt: index + 3, updatedAt: 1,
        }, version: 1 });
    };
    reset();
    // Account persistence and cross-process Action transport are the only substituted boundaries.
    const port: AccountJsonKvCollectionPort = {
        read: async key => rows.get(key) ?? { value: null, version: -1 },
        list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, ...row })),
        mutate: async mutations => {
            const errors = mutations.filter(row => (rows.get(row.key)?.version ?? -1) !== row.version)
                .map(row => ({ key: row.key, ...(rows.get(row.key) ?? { value: null, version: -1 }) }));
            if (errors.length) return { success: false, errors };
            return { success: true, results: mutations.map(row => {
                const version = row.version + 1; rows.set(row.key, { value: row.value, version }); return { key: row.key, version };
            }) };
        },
    };
    const hostWrites: string[] = [];
    const actions = { execute: async (actionId: string, input: unknown) => {
        if (actionId !== 'tasks.internal.list' && actionId !== 'tasks.internal.read' && actionId !== 'tasks.internal.transition') throw new Error(`Unexpected Action ${actionId}`);
        if (actionId === 'tasks.internal.transition') hostWrites.push(actionId);
        return executeInternalTaskAction({ actionId, input, scope, port, requireCurrent: () => {}, createId: () => { throw new Error('No create expected'); } });
    } } as unknown as PluginServices['actions'];
    const corpus = createTestkitCorpusCollections();
    const storage = { account: { collection: (definition: { id: string }) => {
        if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
        if (definition.id === 'session-links') return corpus.collections.sessionLinks;
        if (definition.id === 'user-marks') return corpus.collections.userMarks;
        throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as PluginServices['storage'];
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN,
        services: { actions, storage }, resolveCurrentPluginMaterializationRef: () => null });
    const invocation = (surface: 'ui' | 'agent') => ({ surface, services: {
        targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
            const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
                descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
                    .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
            })) };
        }, dispose() {} }) } as unknown as PluginServices['targetedContributions'],
    } });
    const registrations = createPluginUiClientExecutableRegistrationIndex();
    const activation = registrations.createScope({ pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version,
        contributes: PLUGIN_MANIFEST.contributes, target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
        executionOrigin: null, occurrenceId: 'triage-status', lifecycle: { signal: new AbortController().signal, isCurrent: () => true } });
    activate(activation.api); activation.commit();
    const sourceDefinition = PluginDragSourceContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.dragSources.find(value => value.id === 'entry-reference'));
    const targetDefinition = PluginDropTargetContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.dropTargets.find(value => value.id === 'task-status'));
    const rowTargetDefinition = PluginDropTargetContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.dropTargets.find(value => value.id === 'personal-task-order'));
    const domainWrites: unknown[] = [];
    const runtime = createEntityDragDropRuntime();
    const binding = createPluginEntityDragDropBinding({ runtime, pluginId: PLUGIN_MANIFEST.id, mountKey: 'status', scope, isCurrent: activation.isCurrent,
        readSource: () => {
            const registration = resolvePluginUiClientDragSourceRegistration({ source: { id: `${PLUGIN_MANIFEST.id}/${sourceDefinition.id}`, pluginId: PLUGIN_MANIFEST.id,
                pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-status', definition: sourceDefinition }, platform: 'web', reader: registrations });
            return registration ? { descriptor: sourceDefinition, describe: registration.runtime.describe, isCurrent: registration.registration.lifecycle.isCurrent } : null;
        },
        readTarget: id => {
            const definition = id === rowTargetDefinition.id ? rowTargetDefinition : targetDefinition;
            const registration = resolvePluginUiClientDropTargetRegistration({ target: { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
                pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-status', definition }, platform: 'web', reader: registrations });
            return registration ? { descriptor: definition, resolve: registration.runtime.resolve, settle: registration.runtime.settle,
                isCurrent: registration.registration.lifecycle.isCurrent } : null;
        },
        executeAction: async (action, input, settle) => {
            domainWrites.push(action);
            expect(action).toEqual({ pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 });
            return settlePluginEntityDropActionResult(await kit.invokeAction(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, input, invocation('ui')), action, settle);
        },
    });
    try {
        // The real list contract pages this Collection; scale never enlarges its canonical wire page bound.
        const pages: TriageListEntriesResultV1[] = [];
        let resume: TriageListEntriesResultV1['window']['continuations'];
        do {
            const page = TriageListEntriesResultV1Schema.parse(await kit.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1, order: 'oldest',
                ...(resume === undefined ? {} : { resume }),
            }, invocation('ui')));
            pages.push(page); resume = page.window.continuations;
        } while (resume !== undefined && resume.length > 0);
        const window = foldTriageListWindow({ observations: pages.flatMap(list => list.configuredSources.flatMap(source => laneObservationsFromWire(list, source.sourceInstanceId))),
            lanes: [], configuredSourcesStatus: 'complete',
            activeSourceInstanceIds: pages[0]!.configuredSources.map(source => source.sourceInstanceId),
            lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: taskIds.length }, assembledAtMs: 1 });
        const items = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
            tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false, capabilitiesOf: () => INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities } });
        expect(items).toHaveLength(taskIds.length);
        const item = items.find(item => item.row.entryRef.entryId === 'a')!;
        const group = assignTriageTaskStatusGroup({ key: 'started', title: 'In progress' }, items, { verb: 'Change status', unavailableReason: 'Use the status menu.' });
        if (group.membership?.kind !== 'assignable') throw new Error('Expected a Collection status destination');
        const source = binding.mountSource({ mountId: 'a', sourceId: sourceDefinition.id, reference: { entryRef: item.row.entryRef,
            sourceInstance: { source: item.row.entryRef.source, sourceInstanceId: item.row.sourceInstanceId! },
            lastKnownLocator: item.locator!, title: item.row.title, subtitle: item.row.scopeLabel } })!;
        const target = binding.mountTarget({ mountId: 'done', ...group.membership.target, getBounds: () => ({ x: 100, y: 0, width: 200, height: 600 }) })!;
        const rowTarget = binding.mountTarget({ mountId: 'b', parentId: target.id, targetId: rowTargetDefinition.id,
            input: { scope, targetId: 'b', orderedIds: ['b'],
                preview: { before: 'Move before', after: 'Move after', target: 'Work in progress' }, unavailableReason: 'Only the same group can reorder.' },
            getBounds: () => ({ x: 100, y: 0, width: 200, height: 100 }) })!;
        for (const route of ['pointer', 'card', 'keyboard', 'agent'] as const) {
            reset(); domainWrites.length = 0; hostWrites.length = 0;
            if (route === 'agent') {
                expect(await kit.invokeAction(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { v: 1, entryRef: item.row.entryRef,
                    sourceInstanceId: item.row.sourceInstanceId!, transitionId: 'started' }, invocation('agent'))).toMatchObject({ kind: 'applied' });
            } else {
                const carry = source.begin(route === 'card' ? 'pointer' : route)!;
                if (route === 'pointer' || route === 'card') carry.move({ x: 150, y: route === 'card' ? 50 : 500 }); else carry.choose(target.id);
                if (route === 'card') expect(runtime.getSnapshot().targetId).toBe(rowTarget.id);
                expect(await carry.release()).toEqual({ status: 'applied' });
                expect(domainWrites).toEqual([{ pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 }]);
            }
            expect(hostWrites).toEqual(['tasks.internal.transition']);
            expect(rows.get('todo.a')?.value).toMatchObject({ done: false, state: 'started' });
            expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: taskIds, completedOrder: [] });
        }
        reset(); domainWrites.length = 0; hostWrites.length = 0;
        const canceled = source.begin('keyboard')!; canceled.choose(target.id); canceled.cancel('escape');
        expect(await canceled.release()).toBeNull();
        expect(domainWrites).toEqual([]); expect(hostWrites).toEqual([]);
        expect(rows.get('todo.a')?.value).toMatchObject({ done: false, state: 'unstarted' });
    } finally { binding.dispose(); await activation.unwind(); await kit.dispose(); }
});
