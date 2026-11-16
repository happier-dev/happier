// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { Button, defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { InternalTaskActionIdSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort, type TaskResourceClientOptionsV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1, TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../../manifest.js';
import { TriageListEntriesResultV1Schema, type TriageListEntriesResultV1 } from '../../actions/listEntriesProtocol.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { usePersonalTaskOrder } from './usePersonalTaskOrder.js';
import { useTriageListSessionActivityV1 } from './useListSessionActivity.js';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { createTriageListWindowStore } from '../../projection/listWindowStore.js';
import { planTriageListItemsV1 } from './sections.js';
import { useTriageListSessionActivitySourcesV1 } from './useListSessionActivitySources.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the Task page admitted read', () => {
    it('refreshes 60 Tasks and retains qualified unreadable Session links in Agents with one TaskList and one palette read', async () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const counts = { lists: 0, exact: 0, palettes: 0 };
        let unavailable = false;
        let unreadableTaskId: string | undefined;
        const rows = new Map(Array.from({ length: 60 }, (_, index) => [`todo.task-${index}`, {
            id: `task-${index}`, title: `Task ${index}`, done: false, labels: ['bug'], createdAt: index + 1, updatedAt: index + 1,
            linkedSessions: index === 1 ? {} : { qualified: { title: 'Existing Session', linkedAt: 3,
                session: { ...scope, sessionId: 'stopped-session' } } },
        }]));
        const port: AccountJsonKvCollectionPort = {
            read: async key => { if (key === 'task-label-colours.v1') counts.palettes++; return { value: rows.get(key) ?? null, version: 1 }; },
            list: async prefix => {
                if (unavailable) throw new Error('Account unavailable');
                return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value, version: 1 }));
            },
            mutate: async () => { throw new Error('Reading a page must not write'); },
        };
        const resources: TaskResourceClientOptionsV1 = {
            accountId: scope.accountId, requireCurrent() {},
            crypto: {
                randomBytes: () => { throw new Error('Plain reads need no crypto'); },
                openAccount: async () => { throw new Error('Plain reads need no crypto'); },
                sealAccount: async () => { throw new Error('Plain reads need no crypto'); },
                openKey: async () => { throw new Error('Plain reads need no crypto'); },
                open: async () => { throw new Error('Plain reads need no crypto'); },
                seal: async () => { throw new Error('Plain reads need no crypto'); },
            },
            request: async ({ method, path }) => {
                expect({ method, path }).toEqual({ method: 'GET', path: '/v1/tasks' });
                if (unavailable) throw new Error('Task service unavailable');
                return { status: 200, body: {
                    tasks: [...rows.values()].filter(task => task.id !== unreadableTaskId).map(task => ({
                        ownerAccountId: scope.accountId, taskId: task.id, version: 1, access: 'owner',
                        encryptionMode: 'plain', encryptedDataKey: null, content: { t: 'plain', v: task },
                    })),
                    ...(unreadableTaskId === undefined ? {} : { unavailableTasks: [{ ownerAccountId: scope.accountId,
                        taskId: unreadableTaskId, error: 'task_content_unavailable', reason: 'task_content_invalid' }] }),
                } };
            },
        };
        // Substitute only Task HTTP, persistent Account KV, host Action RPC and Session transport boundaries.
        const actions = { execute: async (id: string, input: unknown) => {
            if (id === 'tasks.internal.list') counts.lists++;
            if (id === 'tasks.internal.read') counts.exact++;
            return executeInternalTaskAction({ actionId: InternalTaskActionIdSchema.parse(id), input, scope, port,
                requireCurrent() {}, createId: () => 'unused', resources });
        } } as unknown as PluginServices['actions'];
        const corpus = createTestkitCorpusCollections();
        const storage = { account: { collection: (definition: { id: string }) => {
            if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
            if (definition.id === 'session-links') return corpus.collections.sessionLinks;
            if (definition.id === 'user-marks') return corpus.collections.userMarks;
            throw new Error(`Unexpected Collection ${definition.id}`);
        } } } as unknown as PluginServices['storage'];
        const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { actions, storage } });
        const invocation = { surface: 'agent' as const, services: {
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
                const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
                return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
                    descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
                        .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
                })) };
            }, dispose() {} }) } as unknown as PluginServices['targetedContributions'],
        } };
        let refresh: (() => Promise<void>) | undefined;
        let page: TriageListEntriesResultV1 | undefined;
        const surface = defineUiSurface(function TaskPageProbe() {
            const host = usePluginHostApi();
            const store = React.useMemo(() => createTriageListWindowStore({
                readEntries: async (input, options) => {
                    const result = TriageListEntriesResultV1Schema.parse(await host.executeAction('tasks/list-v1', input, options));
                    page = result;
                    return result;
                }, nowMs: () => Date.now(),
            }), [host]);
            const current = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
            refresh = () => store.refresh('manual');
            React.useEffect(() => { void refresh?.(); }, []);
            React.useEffect(() => () => store.dispose(), [store]);
            const order = usePersonalTaskOrder(current.window !== undefined, current.taskProjection, () => { void refresh?.(); });
            const refs = React.useMemo(() => current.window?.rows.map(row => row.entryRef) ?? [], [current.window]);
            const sources = useTriageListSessionActivitySourcesV1(current.window ?? null);
            const links = useTriageListSessionActivityV1({ entryRefs: refs,
                taskProjection: current.taskProjection, sourceInstanceIds: sources,
                acquisition: current.passes, active: current.window !== undefined });
            const agents = planTriageListItemsV1({ rows: current.window?.rows ?? [], pins: [],
                workflowSubjectOf: () => 'issue',
                tasks: { audience: 'agents', isTask: ref => ref.kindId === 'task',
                    hasSessions: key => (links.linkedSessions.get(key)?.length ?? 0) > 0 } });
            return <><Text value={`${current.window?.rows.length ?? 0}:${order.available}:${links.linkedSessions.size}`} />
                <Text value={`Agents ${agents.length}:${agents.some(item => item.row.entryRef.entryId === 'task-1')}`} />
                <Text value={current.window?.rows[0]?.content?.outcome.snapshot.title ?? 'Loading Tasks'} />
                <Text value={`Links ${links.linksStatus}`} />
                <Button title="Refresh Tasks" onPress={() => { void refresh?.(); }} /></>;
        });
        let ui: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
        try {
            await act(async () => { ui = await createPluginUiTestkit({
                identity: { instanceId: 'task-page-read', mountNonce: 'task-page-read' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
                surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({
                    ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
                }), handlers: {
                    executeAction: ({ action, input }) => {
                        const id = typeof action === 'string' ? action : action.localId;
                        const hostAction = InternalTaskActionIdSchema.safeParse(id);
                        return hostAction.success ? executeInternalTaskAction({ actionId: hostAction.data, input, scope, port,
                            requireCurrent() {}, createId: () => 'unused', resources }).then(result => {
                                if (hostAction.data === 'tasks.internal.list') counts.lists++;
                                if (hostAction.data === 'tasks.internal.read') counts.exact++;
                                return result;
                            }) : kit.invokeAction(id, input, invocation);
                    },
                    readSession: () => null,
                },
            }); });
            await expect(ui!.getByText(`${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}:true:${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}`)).resolves.toBeDefined();
            await expect(ui!.getByText(`Agents ${MAX_TRIAGE_LIST_WINDOW_ROWS_V1 - 1}:false`)).resolves.toBeDefined();
            expect(page?.window.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
            expect(isExternalActionResultWithinResponseEnvelopeLimitV1(page)).toBe(true);
            expect(counts).toEqual({ lists: 1, exact: 0, palettes: 1 });
            const changedId = page!.window.rows[0]!.entryRef.entryId;
            rows.get(`todo.${changedId}`)!.title = 'Changed Task';
            await act(async () => { await refresh?.(); });
            await expect(ui!.getByText(`${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}:true:${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}`)).resolves.toBeDefined();
            expect(page?.window.rows.some(row => row.entryRef.entryId === changedId
                && row.observation.outcome.kind === 'present' && row.observation.outcome.snapshot.title === 'Changed Task')).toBe(true);
            await expect(ui!.getByText('Changed Task')).resolves.toBeDefined();
            expect(counts).toEqual({ lists: 2, exact: 0, palettes: 2 });
            unreadableTaskId = changedId;
            await act(async () => { await refresh?.(); });
            expect(page?.window.taskProjection?.entries.find(entry => entry.entryRef.entryId === changedId)?.result.kind).toBe('partial');
            await expect(ui!.getByText('Links unavailable')).resolves.toBeDefined();
            unavailable = true;
            await act(async () => { await refresh?.(); });
            await expect(ui!.getByText(`${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}:false:${MAX_TRIAGE_LIST_WINDOW_ROWS_V1}`)).resolves.toBeDefined();
        } finally { await ui?.dispose(); await kit.dispose(); }
    });
});
