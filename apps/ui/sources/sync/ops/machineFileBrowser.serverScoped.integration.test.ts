import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Only socket/HTTP transport and device credential storage are replaced. Home
// admission, routing, response decoding and the file-browser owners stay real.
const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { machineFilesystemListRoots, machineFilesystemListDirectory } = await import('./machineFileBrowser');
const { resolveFilesystemErrorReason } = await import('@/components/ui/filesystemBrowser/filesystemErrorReason');
const { t } = await import('@/text');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://filesystem.example.test', 'account-a');
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

const listings = [
    ['roots', (serverId: string) => machineFilesystemListRoots('machine-1', { serverId, accountId: 'account-a' })],
    ['directory', (serverId: string) => machineFilesystemListDirectory('machine-1', {
        path: '/home/happier/happier-dev', includeFiles: false,
    }, { serverId, accountId: 'account-a' })],
] as const;

describe('file-browser failures across the scoped network boundary', () => {
    it.each(listings)('lists %s on the selected Home with unavailable features', async (_name, list) => {
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            const result = request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS
                ? { ok: true, roots: [{ id: '/', label: '/', path: '/' }] }
                : { ok: true, path: '/home/happier/happier-dev', entries: [], truncated: false };
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId);
        });
        expect(await list(home.id)).toMatchObject({ ok: true });
        expect(boundary.requests).toContainEqual(expect.objectContaining({ serverUrl: home.serverUrl, targetId: 'machine-1' }));
    });

    it.each(listings)('does not disguise the live server ReferenceError as a missing %s method', async (_name, list) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'verifiedWorkspaceSyncTargetContinuation is not defined' }));
        const result = await list(home.id);
        expect(boundary.requests.length).toBeGreaterThan(0);
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_FAILED', errorCode: 'MACHINE_RPC_FAILED' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.operationFailed'));
    });

    it.each([
        [RPC_ERROR_CODES.FORBIDDEN, 'errors.permissionDenied'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'errors.daemonUnavailableBody'],
        [RPC_ERROR_CODES.METHOD_NOT_FOUND, 'errors.operationFailed'],
    ] as const)('preserves the %s failure class without exposing server exception text', async (code, key) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'private server internals', errorCode: code }));
        for (const [, list] of listings) {
            const result = await list(home.id);
            expect(boundary.requests.length).toBeGreaterThan(0);
            expect(result).toMatchObject({ ok: false, errorCode: code });
            if (result.ok) throw new Error('Expected listing refusal');
            expect(result.error).not.toContain('private server internals');
            expect(resolveFilesystemErrorReason(result.error)).toBe(t(key));
        }
        expect(resolveFilesystemErrorReason(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(t('errors.daemonUnavailableBody'));
    });

    it('distinguishes an acknowledgement timeout from unsupported methods', async () => {
        boundary.setRpcAckResponder(async () => { throw new Error('operation has timed out'); });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id, timeoutMs: 1_000 });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_TIMEOUT', errorCode: 'MACHINE_RPC_TIMEOUT' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.connectionTimeout'));
    });

    it('classifies a failed socket connection as unreachable without disclosing its exception', async () => {
        boundary.setSocketConfigurator(({ socket, trigger }) => {
            socket.connect.mockImplementation(() => trigger('connect_error', new Error('private transport details')));
        });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_UNREACHABLE', errorCode: 'MACHINE_RPC_UNREACHABLE' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.networkError'));
    });

    it('preserves caller cancellation rather than presenting a listing failure', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(machineFilesystemListRoots('machine-1', { serverId: home.id, signal: controller.signal })).rejects.toThrow();
    });
});
