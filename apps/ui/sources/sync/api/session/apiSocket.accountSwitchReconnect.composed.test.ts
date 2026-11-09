import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

// Only the Socket.IO transport is a boundary here; the connection owner, TokenStorage, the
// credential fan-out and the scoped-context route are the real ones.
const ioSpy = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));

const { serveAccountHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
// Collect the real Sync graph before the connection owner's restore runs.
await import('@/sync/ops/actions/defaultActionExecutor');

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
    await dispose?.();
    dispose = null;
    ioSpy.mockReset();
});

describe('focused-Home socket after its Account leaves', () => {
    it('neither reconnects with the departed credential nor routes a later Machine read through it', async () => {
        const boundary = createSocketIoBoundaryStub({ autoConnect: false });
        ioSpy.mockReturnValue(boundary.socket);
        const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://switch-reconnect.example.test', accountId: 'account-a' }],
            route: () => undefined });
        dispose = homes.dispose;
        const home = homes.homes.a!;
        const { apiSocket } = await import('./apiSocket');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { subscribeHomeCredentialChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { isAppliedActiveServerRuntimeAvailable, retireAppliedActiveServerCredentialAuthorityIfChanged } =
            await import('@/sync/runtime/orchestration/connectionManager');
        const { resolveServerScopedContext } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext');
        const { createServedHomeAccountToken } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const tokenA = (await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id }))!.token;
        expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
        // The app's AuthContext forwards every Home credential change to the connection owner.
        const stop = subscribeHomeCredentialChange(event => { retireAppliedActiveServerCredentialAuthorityIfChanged(event); });
        try {
            const tokenB = createServedHomeAccountToken('account-b');
            // Account B signs in on the same Home; Sync has not re-initialized yet.
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: tokenB })).toBe(true);
            const before = ioSpy.mock.calls.length;
            const connectsBefore = boundary.socket.connect.mock.calls.length;
            // A foreground resume or manual Retry reconnects inside that window.
            apiSocket.disconnect();
            apiSocket.connect();
            // The transport is rebuilt once reachability answers; give that path time to run.
            await new Promise(resolve => setTimeout(resolve, 5_000));
            const reconnectTokens = ioSpy.mock.calls.slice(before)
                .map(call => (call[1] as { auth?: { token?: string } } | undefined)?.auth?.token);
            expect(reconnectTokens).not.toContain(tokenA);
            // Nothing re-opens the Socket.IO transport this test holds (it was built with A's token).
            expect(boundary.socket.connect.mock.calls.length).toBe(connectsBefore);
            // A Machine read issued now (no explicit Account, as the file-browser caches do) goes to B's credential.
            const context = await resolveServerScopedContext({ machineId: 'machine-1', serverId: home.id });
            expect(context).toMatchObject({ scope: 'scoped', targetAccountId: 'account-b', token: tokenB });
        } finally { stop(); }
    }, 180_000);
});
