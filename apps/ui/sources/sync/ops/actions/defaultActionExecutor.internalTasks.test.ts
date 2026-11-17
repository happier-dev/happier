import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TaskResourceV1Schema, TaskResourcesListResponseV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';

const homes = createHomeGovernanceHarness();
// HTTP, credentials, disconnected sockets and native dialogs are host boundaries.
// Executor construction, Action admission and Task storage adapters remain real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

describe('mounted host Task reads through the Account executor', () => {
    it('constructs the Account executor and retains linked Tasks across list and detail reads', async () => {
        const serverUrl = 'https://mounted-task-actions.test';
        const serverId = await homes.addHome({ name: 'Mounted Task Home', serverUrl, accountId: 'owner', currentAccount: true });
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected test Account credentials');
        await restoreConnectionToActiveServer(credentials);
        const task = TaskResourceV1Schema.parse({ ownerAccountId: 'owner', taskId: 'linked', access: 'owner',
            encryptionMode: 'plain', encryptedDataKey: null, version: 1,
            content: { t: 'plain', v: { id: 'linked', title: 'Retained Session task', done: false, createdAt: 1, updatedAt: 1,
                linkedSessions: { stopped: { title: 'Stopped Session', linkedAt: 1,
                    session: { serverId, accountId: 'owner', sessionId: 'stopped-session' } } } } } });
        homes.answer(serverId, 'GET /v1/tasks', { body: TaskResourcesListResponseV1Schema.parse({ tasks: [task] }) });
        homes.answer(serverId, 'GET /v1/tasks/owner/linked', { body: task });
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });
        const executor = createDefaultActionExecutor();
        const context = { serverId, surface: 'ui' as const, actionCaller: { kind: 'host' as const } };
        const expected = { id: 'linked', title: 'Retained Session task',
            linkedSessions: { stopped: { title: 'Stopped Session', linkedAt: 1,
                session: { serverId, accountId: 'owner', sessionId: 'stopped-session' } } } };
        const listed = await executor.execute('tasks.internal.list', {}, context);
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true,
            result: { status: 'ok', todos: [expected] } });
        const detail = await executor.execute('tasks.internal.read', { taskId: 'linked' }, context);
        expect(detail, JSON.stringify(detail)).toMatchObject({ ok: true,
            result: { status: 'applied', todo: expected } });
    });
});
