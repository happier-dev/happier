import { describe, expect, it } from 'vitest';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { PluginDragSourceContributionV1Schema, PluginDropTargetContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/entityDragDrop';
import { executeInternalTaskAction, executeInternalTaskReorder, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { createPluginUiClientExecutableRegistrationIndex, resolvePluginUiClientDragSourceRegistration, resolvePluginUiClientDropTargetRegistration } from '../../reactNative/clientExecutableContributions';
import { createPluginEntityDragDropBinding, settlePluginEntityDropActionResult } from './pluginEntityDragDropBinding';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/triage/src/manifest';
import { activate, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 } from '../../../../../../../packages/plugins/triage/src/ui/list/entryDragDrop';

const scope = { serverId: 'home', accountId: 'account' };

describe('Tasks manual order through the public plugin binding and canonical Account CAS', () => {
    it('makes pointer drag, staged Move and agent Action produce the same current order', async () => {
        const sourceDefinition = PluginDragSourceContributionV1Schema.parse(PLUGIN_MANIFEST.contributes.dragSources.find(value => value.id === 'entry-reference'));
        const declaredTarget = PLUGIN_MANIFEST.contributes.dropTargets.find((value: { id: string }) => value.id === 'personal-task-order');
        expect(declaredTarget).toBeDefined();
        const targetDefinition = PluginDropTargetContributionV1Schema.parse(declaredTarget);
        const registrations = createPluginUiClientExecutableRegistrationIndex();
        const activation = registrations.createScope({ pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version,
            contributes: PLUGIN_MANIFEST.contributes, target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
            executionOrigin: null, occurrenceId: 'triage-tasks', lifecycle: { signal: new AbortController().signal, isCurrent: () => true } });
        activate(activation.api);
        activation.commit();
        const rows = new Map<string, { value: unknown; version: number }>();
        // Persistent Account KV is the boundary. Its CAS shape is real; domain
        // membership, reference admission, Action parsing and reordering stay real.
        const port: AccountJsonKvCollectionPort = {
            read: async key => rows.get(key) ?? { value: null, version: -1 },
            list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, ...row })),
            mutate: async mutations => {
                const conflicts = mutations.filter(row => (rows.get(row.key)?.version ?? -1) !== row.version);
                if (conflicts.length) return { success: false, errors: conflicts.map(row => ({ key: row.key, ...(rows.get(row.key) ?? { value: null, version: -1 }) })) };
                const results = mutations.map(row => { const version = row.version + 1; rows.set(row.key, { value: row.value, version }); return { key: row.key, version }; });
                return { success: true, results };
            },
        };
        const reset = () => {
            rows.clear();
            rows.set('todo.index', { value: { undoneOrder: ['a', 'b', 'c'], completedOrder: [] }, version: 1 });
            for (const id of ['a', 'b', 'c']) rows.set(`todo.${id}`, { value: { id, title: id, done: false, state: 'unstarted', createdAt: 1, updatedAt: 1 }, version: 1 });
        };
        const reorder = (input: unknown) => executeInternalTaskReorder({ input, scope, port, requireCurrent: () => {} });
        const runtime = createEntityDragDropRuntime();
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: PLUGIN_MANIFEST.id, mountKey: 'tasks', scope, isCurrent: activation.isCurrent,
            readSource: () => {
                const registration = resolvePluginUiClientDragSourceRegistration({ source: { id: `${PLUGIN_MANIFEST.id}/${sourceDefinition.id}`, pluginId: PLUGIN_MANIFEST.id,
                    pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-tasks', definition: sourceDefinition }, platform: 'web', reader: registrations });
                return registration ? { descriptor: sourceDefinition, describe: registration.runtime.describe, isCurrent: registration.registration.lifecycle.isCurrent } : null;
            },
            readTarget: () => {
                const registration = resolvePluginUiClientDropTargetRegistration({ target: { id: `${PLUGIN_MANIFEST.id}/${targetDefinition.id}`, pluginId: PLUGIN_MANIFEST.id,
                    pluginVersion: PLUGIN_MANIFEST.version, occurrenceId: 'triage-tasks', definition: targetDefinition }, platform: 'web', reader: registrations });
                return registration ? { descriptor: targetDefinition, resolve: registration.runtime.resolve, isCurrent: registration.registration.lifecycle.isCurrent } : null;
            },
            executeAction: async (action, input) => {
                expect(action).toBe('tasks.internal.reorder');
                return settlePluginEntityDropActionResult(await reorder(input), action);
            },
        });
        const source = binding.mountSource({ mountId: 'a', sourceId: sourceDefinition.id, reference: {
            entryRef: { source: { pluginId: 'happier.triage', localId: 'internal' }, kindId: 'task', collisionScope: 'personal', entryId: 'a' },
            sourceInstance: { source: { pluginId: 'happier.triage', localId: 'internal' }, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            lastKnownLocator: { v: 1, routingToken: 'a', displayPath: 'a' }, title: 'a', subtitle: 'Personal',
        } })!;
        const target = binding.mountTarget({ mountId: 'c', targetId: targetDefinition.id,
            input: { scope, targetId: 'c', orderedIds: ['a', 'b', 'c'], preview: { before: 'Move before', after: 'Move after', target: 'c' }, unavailableReason: 'Only unfinished personal tasks in this group can be reordered.' },
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 40 }) })!;
        try {
            const orders: unknown[] = [];
            for (const route of ['pointer', 'keyboard', 'agent'] as const) {
                reset();
                if (route === 'agent') expect(await reorder({ scope, sourceId: 'a', position: { anchorId: 'c', placement: 'after' } })).toEqual({ status: 'applied' });
                else {
                    const carry = source.begin(route)!;
                    if (route === 'pointer') carry.move({ x: 20, y: 20 }); else carry.choose(target.id);
                    expect(await carry.release()).toEqual({ status: 'applied' });
                }
                const list = await executeInternalTaskAction({ actionId: 'tasks.internal.list', input: {}, scope, port, requireCurrent: () => {}, createId: () => { throw new Error('No create expected'); } });
                expect(list.status).toBe('ok');
                if (list.status === 'ok') orders.push(list.undoneOrder);
            }
            expect(orders).toEqual([['b', 'c', 'a'], ['b', 'c', 'a'], ['b', 'c', 'a']]);
            reset();
            const canceled = source.begin('keyboard')!;
            canceled.choose(target.id); canceled.cancel('escape');
            expect(await canceled.release()).toBeNull();
            expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['a', 'b', 'c'], completedOrder: [] });
            const completing = source.begin()!;
            completing.move({ x: 20, y: 20 });
            await executeInternalTaskAction({ actionId: 'tasks.internal.transition', input: { scope, taskId: 'c', state: 'completed' }, scope, port, requireCurrent: () => {}, createId: () => '' });
            expect(await completing.release()).toMatchObject({ status: 'refused', reason: { code: 'todo_reorder_stale' } });
            expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['a', 'b'], completedOrder: ['c'] });
        } finally { binding.dispose(); await activation.unwind(); }
    });
});
