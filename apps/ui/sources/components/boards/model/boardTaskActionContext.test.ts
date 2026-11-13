import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { TaskResourceV1Schema, TaskResourcesListResponseV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

it('reads linked tasks through the real Board Account Action front door', async () => {
    const { createPluginUiClientExecutableRegistrationIndex } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readBoardTaskItems } = await import('./boardTaskItems');
    const serverUrl = 'https://board-task-actions.test';
    const serverId = await homes.addHome({ name: 'Board Home', serverUrl, accountId: 'owner', currentAccount: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Expected fixture Home credentials');
    await restoreConnectionToActiveServer(credentials);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected fixture Account lifetime');
    const task = { id: 'linked-task', title: 'Readable linked task', done: false, createdAt: 1, updatedAt: 1 };
    homes.answer(serverId, 'GET /v1/tasks', { body: TaskResourcesListResponseV1Schema.parse({ tasks: [TaskResourceV1Schema.parse({
        ownerAccountId: 'owner', taskId: task.id, access: 'owner', encryptionMode: 'plain', encryptedDataKey: null,
        version: 1, content: { t: 'plain', v: task },
    })] }) });
    homes.answer(serverId, 'GET /v1/kv/todo.index', { body: { key: 'todo.index', version: 1,
        value: Buffer.from(JSON.stringify({ t: 'plain', v: { undoneOrder: [task.id], completedOrder: [] } })).toString('base64') } });
    // This authored test client implements Work Items only, rather than the production drag/drop client.
    const contributes = PluginContributesV2Schema.parse({ ...PLUGIN_MANIFEST.contributes, dragSources: [], dropTargets: [] });
    const definition = contributes.workItems[0]!;
    const controller = new AbortController();
    const sourceCustody = { kind: 'bundled_first_party' as const,
        packagedRuntime: { kind: 'source_declaration' as const, packageName: '@happier-dev/plugins-triage' } };
    const occurrenceId = 'board-account-triage';
    const index = createPluginUiClientExecutableRegistrationIndex();
    const scope = index.createScope({ pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version,
        contributes, occurrenceId, target: { ...definition.client, platform: 'web' }, executionOrigin: null, accountLifetime,
        authority: { kind: 'account', ...accountLifetime.scope, custodyId: occurrenceId },
        lifecycle: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } });
    let actionFailure: unknown;
    scope.api.workItems.register(definition.id, {
        findLinked: async (_selection, context) => {
            const result = await context.services.actions.execute('tasks.internal.list', {}).catch(error => {
                actionFailure = error;
                throw error;
            });
            if (!result || typeof result !== 'object' || !('todos' in result) || !Array.isArray(result.todos)) throw new Error('Expected Task list');
            return { itemIds: result.todos.map(todo => String(todo.id)), complete: true };
        },
        resolve: async ({ itemIds }) => Object.fromEntries(itemIds.map(id => [id, { title: task.title, category: 'unstarted' as const,
            linkedSessions: [{ serverId, sessionId: 'worker' }] }])),
    });
    scope.commit();
    const disposeLoader = await installRealActionExecutorModuleLoader();
    try {
        // The projection carries the Account origin stamp as an open field the registration reader decodes.
        const source = { id: `${PLUGIN_MANIFEST.id}/${definition.id}`, pluginId: PLUGIN_MANIFEST.id,
            pluginVersion: PLUGIN_MANIFEST.version, definition, occurrenceId,
            hostAccountOrigin: { ...accountLifetime.scope, custodyId: occurrenceId, sourceCustody } };
        const result = await readBoardTaskItems({ serverId, refs: [], sessions: [{ serverId, sessionId: 'worker' }],
            sources: [source],
            platform: 'web', reader: index, signal: controller.signal, accountLifetime });
        expect(actionFailure).toBeUndefined();
        expect(result.complete).toBe(true);
        expect(result.linkedRefs).toEqual([{ kind: 'task', pluginId: PLUGIN_MANIFEST.id, qualifiedId: { serverId, id: task.id } }]);
        expect([...result.items.values()]).toMatchObject([{ title: task.title }]);
    } finally { controller.abort(); disposeLoader(); await scope.unwind(); }
});
