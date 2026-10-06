import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        throw new Error('Retired terminal intent reached daemon transport');
    });
});
let serverId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

describe('terminal captured Account scope', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-home.test', accountId: 'account-a' });
        outgoing.length = 0;
    });
    afterEach(async () => {
        await homes.reset();
        vi.restoreAllMocks();
        webLocks.restore();
    });

    it('rejects retained lifecycle operations after credentials switch within the same Home', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
        const executor = createDefaultActionExecutor();
        const scopeId = createSessionPaneScopeId('session-1', serverId);
        const context = { surface: 'ui' as const, serverId };
        // The public Action preparation owns captured Account authority. The
        // low-level terminal RPC options have no retained Account-id contract.
        const retained = await Promise.all([
            executor.prepare('machines.terminal.open', { machineId: 'machine-1', terminalKey: 'terminal-key', cwd: '/tmp', cols: 80, rows: 24 }, context),
            executor.prepare('session.terminals.restart', { scopeId, terminalId: 'terminal-a' }, context),
            executor.prepare('session.terminals.close', { scopeId, terminalId: 'terminal-a' }, context),
        ]);
        expect(retained.every((prepared) => prepared.kind === 'ready')).toBe(true);
        await homes.switchAccount(serverId, 'account-b');
        homes.requests.length = 0;
        for (const prepared of retained) {
            if (prepared.kind !== 'ready') throw new Error('expected_ready_terminal_action');
            await expect(prepared.invocation.run()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        }
        expect(outgoing).toEqual([]);
        expect(homes.requests.some(({ path }) => path.startsWith('/v1/machines/'))).toBe(false);
    });

    it('refuses an explicit Home whose credential no longer matches the captured Account', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-terminal-home.test', accountId: 'account-b', active: false });
        const result = await createDefaultActionExecutor().prepare('machines.terminal.open', {
            machineId: 'machine-1', terminalKey: 'terminal-key', cwd: '/tmp',
        }, { surface: 'ui', serverId: otherHome, expectedAccountId: 'account-a' });
        expect(result).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_account_scope_changed' } });
        expect(outgoing).toEqual([]);
    });
});
