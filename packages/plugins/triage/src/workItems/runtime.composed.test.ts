import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginAccountApi, PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { InternalTaskActionIdSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { buildTriageEntryRouteSegmentV1, TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import { resolveTriageWorkItems } from './runtime.js';

describe('internal task Work Items batch', () => {
    it('opens the task inventory once for selected tasks, sharing observations and Session links', async () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const source = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source;
        // The existing Board census observed 57 singleton task reads. Include
        // unrelated tasks so per-entry inventory reopening is visible in cost.
        const todos = Array.from({ length: 60 }, (_, index) => ({
            id: `task-${index}`, title: `Task ${index}`, done: false, createdAt: index, updatedAt: 100,
            ...(index === 0 ? { parentId: 'task-1' } : {}),
            linkedSessions: { session: { title: 'Current work', linkedAt: 3, session: { ...scope, sessionId: 'session' } },
                foreign: { title: 'Other Home', linkedAt: 4, session: { ...scope, serverId: 'other-home', sessionId: 'foreign' } } },
        }));
        const rows = new Map<string, { value: unknown; version: number }>(todos.map(todo => [`todo.${todo.id}`, { value: todo, version: 1 }]));
        let inventories = 0, bodiesOpened = 0, exactReads = 0;
        const port: AccountJsonKvCollectionPort = {
            read: async key => { if (key.startsWith('todo.') && key !== 'todo.index') exactReads++;
                return structuredClone(rows.get(key) ?? { value: null, version: -1 }); },
            list: async prefix => {
                inventories++;
                const selected = [...rows].filter(([key]) => key.startsWith(prefix));
                bodiesOpened += selected.length;
                return selected.map(([key, row]) => ({ key, ...structuredClone(row) }));
            },
            mutate: async () => { throw new Error('A Board read must not mutate tasks'); },
        };
        // Replace only the host Action transport and Account persistence. Real
        // task semantics, source registration, admission and qualification run.
        const actions = { execute: async (id: string, input: unknown) => executeInternalTaskAction({
            actionId: InternalTaskActionIdSchema.parse(id), input, scope, port, requireCurrent: () => {}, createId: () => 'unused',
        }) } as unknown as PluginServices['actions'];
        const { collections } = createTestkitCorpusCollections();
        const storage = { account: { collection: (definition: { id: string }) => {
            if (definition.id === 'source-instances') return collections.sourceInstances;
            if (definition.id === 'session-links') return collections.sessionLinks;
            if (definition.id === 'user-marks') return collections.userMarks;
            throw new Error(`Unexpected Collection ${definition.id}`);
        } } } as unknown as PluginServices['storage'];
        let run: ((context: PluginAccountActionContext) => Promise<void>) | undefined;
        let kit: Awaited<ReturnType<typeof createPluginTestkit>>;
        const targetedContributions = { observeForSelf: () => ({ readCurrent: async () => {
            const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
                descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
                    .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
            })) };
        }, dispose() {} }) } as unknown as PluginServices['targetedContributions'];
        kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { ...TRIAGE_PLUGIN,
            activateAccount(api: PluginAccountApi) {
                TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
                    api.actions.register(id, async (input, context) => {
                        const invoke = run; run = undefined;
                        const current = { ...context, services: { ...context.services, targetedContributions } };
                        if (invoke) await invoke(current);
                        return handler(input, current);
                    }, options);
                } } });
            },
        }, services: { actions, storage } });
        const itemIds = todos.slice(0, 3).map(todo => buildTriageEntryRouteSegmentV1({ source,
            kindId: 'task', collisionScope: 'personal', entryId: todo.id }));
        try {
            run = async context => {
                const first = await resolveTriageWorkItems({ serverId: scope.serverId, itemIds }, context);
                expect(itemIds.map(id => first[id]?.title)).toEqual(['Task 0', 'Task 1', 'Task 2']);
                expect(first[itemIds[0]!]!.parentItemId).toBe(itemIds[1]);
                expect(first[itemIds[0]!]!.linkedSessions).toEqual([{ serverId: scope.serverId, sessionId: 'session' }]);
                expect({ inventories, bodiesOpened, exactReads }).toEqual({ inventories: 1, bodiesOpened: 60, exactReads: 0 });
                rows.set('todo.task-0', { value: { ...todos[0]!, title: 'Updated task', linkedSessions: {} }, version: 2 });
                const second = await resolveTriageWorkItems({ serverId: scope.serverId, itemIds }, context);
                expect(second[itemIds[0]!]!).toMatchObject({ title: 'Updated task', linkedSessions: [] });
                expect({ inventories, bodiesOpened, exactReads }).toEqual({ inventories: 2, bodiesOpened: 120, exactReads: 0 });
            };
            await kit.invokeAction('sources/read-configured-v1', { v: 1 }, { surface: 'agent' });
        } finally { await kit.dispose(); }
    });
});
