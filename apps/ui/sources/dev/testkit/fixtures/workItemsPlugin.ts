import { definePlugin, PluginWorkItemTransitionInputV1Schema, type PluginClientApi, type PluginWorkItemV1, type PluginWorkItemsRuntime } from '@happier-dev/plugin-sdk';

/** Authenticated Account/source facts at the executable-loader boundary. */
export function createWorkItemsAccountFixture(serverId: string, signal: AbortSignal) {
    const accountLifetime = { scope: { serverId, accountId: 'work-items-account' },
        isCurrent: () => !signal.aborted, onRetire: () => ({ dispose() {} }) };
    return { accountLifetime };
}

/** External author's live source, with the provider boundary held in memory only in tests. */
export function createExternalWorkItemsPluginFixture(initial: Readonly<Record<string, PluginWorkItemV1>>) {
    const items = new Map(Object.entries(initial));
    const listeners = new Set<() => void>();
    const client = { artifactId: 'tasks', exportName: 'activate' };
    const setItem = (id: string, item: PluginWorkItemV1) => {
        items.set(id, item);
        for (const changed of listeners) changed();
    };
    const plugin = definePlugin({ id: 'com.acme.board-work', version: '1.0.0',
        workItems: { 'work-items': { client, platforms: ['web'], transitionAction: 'transition' } },
        actions: { transition: {
            title: 'Change task status', surfaces: ['ui', 'plugin'], execution: { target: 'daemon' },
            dangerLevel: 'writesLocal', confirmation: { title: 'Change task status?' }, confirmationWhen: { presentUserUi: false },
            inputSchema: PluginWorkItemTransitionInputV1Schema,
            run: async ({ itemId, transitionId }, context) => {
                const item = items.get(itemId);
                const transition = item?.transitions?.find(candidate => candidate.id === transitionId);
                if (!item || !transition) throw new Error('Unknown task transition');
                setItem(itemId, { ...item, category: transition.category, categoryLabel: transition.label });
                return { category: transition.category, surface: context.surface };
            },
        } },
    });
    const runtime = {
        resolve: async ({ itemIds }) => Object.fromEntries(itemIds.map(id => [id, items.get(id) ?? null])),
        findLinked: async ({ serverId, sessionIds }) => ({ itemIds: [...items].filter(([, item]) => item.linkedSessions.some(link =>
            link.serverId === serverId && sessionIds.includes(link.sessionId))).map(([id]) => id), complete: true }),
        watch: (_request, changed) => { listeners.add(changed); return () => { listeners.delete(changed); }; },
    } satisfies PluginWorkItemsRuntime;
    return { plugin, client, runtime, setItem, activateClient: (api: PluginClientApi) => api.workItems.register('work-items', runtime) };
}
