import { describe, expect, it } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { InternalTaskActionIdSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageSourceSessionRelations } from './sourceSessionRelations.js';

const scope = { serverId: 'home', accountId: 'account' };
const instance = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance;

describe('internal task entry-set Session links', () => {
    it('reads a cold Session relation from Account tasks without a daemon source claim', async () => {
        let unavailable = false;
        const rows = new Map<string, unknown>([['todo.task-offline', {
            id: 'task-offline', title: 'Offline task', done: false, createdAt: 1, updatedAt: 2,
            linkedSessions: { session: { title: 'Session', linkedAt: 3 } },
        }]]);
        const port: AccountJsonKvCollectionPort = {
            read: async key => ({ value: rows.get(key) ?? null, version: 1 }),
            list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, version: 1 })),
            mutate: async () => { throw new Error('Read must not write'); },
        };
        const context = { signal: new AbortController().signal, services: {
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [] }), dispose() {} }) },
            actions: { execute: async (id: string, input: unknown) => unavailable
                ? { status: 'failed', reason: 'task_storage_unavailable' }
                : executeInternalTaskAction({
                actionId: InternalTaskActionIdSchema.parse(id), input, scope, port, requireCurrent: () => {}, createId: () => 'unused',
            }) },
        } } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0];
        const { collections } = createTestkitCorpusCollections();
        const read = () => createTriageSourceSessionRelations(context, collections).read({ sessionId: 'session' });
        const result = await read();
        expect(result.links).toMatchObject([{ entryRef: { entryId: 'task-offline' }, sessionId: 'session', linkedAtMs: 3 }]);
        expect(result.lanes).toContainEqual(expect.objectContaining({ sourceInstanceId: instance.sourceInstanceId, health: { kind: 'complete' } }));
        unavailable = true;
        expect((await read()).lanes).toContainEqual(expect.objectContaining({ sourceInstanceId: instance.sourceInstanceId,
            health: expect.objectContaining({ kind: 'failed' }) }));
        unavailable = false;
        expect((await read()).links).toEqual(result.links);
    });
    it.each([1, 60])('reads %i task links with one Account task read and no daemon dispatch', async count => {
        const reads: string[] = [];
        let taskLists = 0;
        let taskReads = 0;
        let sourceReads = 0;
        let admissions = 0;
        const entries = Array.from({ length: count }, (_, index) => ({ entryRef: {
            source: instance.source, kindId: 'task', collisionScope: 'personal', entryId: `task-${index}`,
        } }));
        const rows = new Map(entries.map(({ entryRef }) => [`todo.${entryRef.entryId}`, {
            id: entryRef.entryId, title: entryRef.entryId, labels: ['bug'], done: false, createdAt: 1, updatedAt: 2,
            linkedSessions: { session: { title: 'Session', linkedAt: 3 } },
        }]));
        const port: AccountJsonKvCollectionPort = {
            read: async key => { reads.push(key); return { value: rows.get(key) ?? null, version: 1 }; },
            list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, version: 1 })),
            mutate: async () => { throw new Error('A relation read must not write'); },
        };
        // Substitute only host Action RPC and persistent Account KV boundaries.
        const actions = { execute: async (id: string, input: unknown) => {
            if (id === 'tasks.internal.list') taskLists++;
            if (id === 'tasks.internal.read') taskReads++;
            return executeInternalTaskAction({ actionId: InternalTaskActionIdSchema.parse(id), input, scope,
                port, requireCurrent: () => {}, createId: () => 'unused' });
        } } as unknown as PluginServices['actions'];
        const readOperation = { role: 'internal-read' };
        const context = { signal: new AbortController().signal, services: {
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
                admissions++;
                return { contributions: [{ contributor: { pluginId: instance.source.pluginId, contributionId: instance.source.localId },
                    descriptor: INTERNAL_TASK_DESCRIPTOR_V1, operations: { readSessionLinks: readOperation, linkSession: { role: 'internal-write' } } }] };
            }, dispose() {} }) },
            actions: { ...actions, executeAdmittedTargetedOperation: async () => {
                sourceReads++;
                throw new Error('Native Account reads must not dispatch to a daemon');
            } },
        } } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0];
        {
            const { collections } = createTestkitCorpusCollections();
            const relations = createTriageSourceSessionRelations(context, collections);
            const result = await relations.readEntries(entries);
            expect(result.map(row => row.result)).toEqual(entries.map(({ entryRef }) => ({ kind: 'complete',
                links: [{ entryRef, sessionId: 'session', linkedAtMs: 3, displayPath: entryRef.entryId,
                    sourceInstanceId: instance.sourceInstanceId, sourceInstanceRevision: 1, sourceInstanceRowId: 'happier-personal-tasks' }],
                lanes: [{ ...instance, displayLabel: 'Happier tasks', kindIds: ['task'], health: { kind: 'complete' } }],
            })));
            expect({ sourceReads, taskLists, taskReads, paletteReads: reads.filter(key => key === 'task-label-colours.v1').length,
                admissions }).toEqual({ sourceReads: 0, taskLists: 1, taskReads: 0, paletteReads: 1, admissions: 1 });
            // A new set demand must observe a changed link rather than reuse retained rows.
            rows.get('todo.task-0')!.linkedSessions.session.linkedAt = 4;
            expect((await relations.readEntries(entries))[0]!.result.links[0]?.linkedAtMs).toBe(4);
            expect(taskLists).toBe(2);
            expect(sourceReads).toBe(0);
        }
    });
});
