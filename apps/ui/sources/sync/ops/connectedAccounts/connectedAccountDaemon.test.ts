import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, type ConnectedAccountDaemonControlResponse } from '@happier-dev/protocol';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
const answers: unknown[] = [];
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        if (!answers.length) throw new Error('Unexpected connected-account daemon request');
        return { ok: true, result: answers.shift() };
    });
});
const service = { pluginId: 'acme.accounts', localId: 'work' } as const;
const beginConnect = { operation: 'beginConnect', service, modeId: 'manual' } as const;
const machineRow = { machine: { id: 'machine-1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } };
let serverId: string;

describe('connected-account daemon machine RPC', () => {
    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Accounts Home', serverUrl: 'https://connected-accounts.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/machine-1', { body: machineRow });
        outgoing.length = 0;
        answers.length = 0;
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await homes.reset();
        vi.restoreAllMocks();
    });
    it('rejects response shapes outside the daemon wire contract', async () => {
        const { ConnectedAccountAttemptResponseSchema } = await import('./connectedAccountDaemon');
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'awaitingOAuth', attemptId: 'attempt-1',
            authorizationUrl: 'not-a-url', callbackUrl: 'http://127.0.0.1/callback' }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1',
            verificationUri: 'https://example.com/' + 'x'.repeat(8192), pollIntervalMs: 0 }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'pending', attemptId: 'attempt-1', retryAfterMs: 1.5 }).success).toBe(false);
    });
    it('routes authentication through the exact server and machine owner', async () => {
        answers.push({ status: 'awaitingManual', attemptId: 'attempt-1' });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: beginConnect }))
            .resolves.toEqual({ status: 'awaitingManual', attemptId: 'attempt-1' });
        expect(outgoing).toMatchObject([{ method: 'machine-1:daemon.connectedAccounts.authentication.command',
            params: { v: 1, machineId: 'machine-1', command: beginConnect } }]);
        expect(homes.requestsFor('/v1/machines/machine-1')[0]?.serverId).toBe(serverId);
    });
    it('rejects an expected active-server basis that does not match the routed server', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const expectedActiveServer = getActiveServerSnapshot();
        const otherHome = await homes.addHome({ name: 'Other Accounts Home', serverUrl: 'https://other-connected-accounts.test', accountId: 'account-b', active: false });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({
            serverId: otherHome, machineId: 'machine-1', expectedActiveServer, command: beginConnect,
        })).rejects.toMatchObject({ code: 'STALE_SERVER_GENERATION' });
        expect(outgoing).toEqual([]);
    });
    it('rechecks the active-server basis before exact machine-RPC issuance after network discovery', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const expectedActiveServer = getActiveServerSnapshot();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        homes.answer(serverId, '/v1/machines/machine-1', { body: machineRow, respondAfter: held });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        const pending = runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', expectedActiveServer, command: beginConnect });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_SERVER_GENERATION' });
        try {
            await vi.waitFor(() => expect(homes.requestsFor('/v1/machines/machine-1')).toHaveLength(1));
            await homes.addHome({ name: 'New focused Home', serverUrl: 'https://new-connected-account-home.test', accountId: 'account-b' });
        } finally { release(); }
        await rejected;
        expect(outgoing).toEqual([]);
    });
    it('sends only daemon-owned OAuth callback fields and rejects malformed responses', async () => {
        answers.push({ status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'account-1' } });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        const completion = { code: 'code-1', callbackUrl: 'http://127.0.0.1/callback', state: 'state-1' };
        await runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'completeOAuth', attemptId: 'attempt-1', completion } });
        expect(outgoing[0]).toMatchObject({ params: { command: { operation: 'completeOAuth', completion } } });
        const payload = outgoing[0]?.params;
        if (!payload || typeof payload !== 'object' || !('command' in payload)) throw new Error('expected_authentication_wire');
        expect(payload.command).toMatchObject({ completion });
        expect(JSON.stringify(payload)).not.toContain('pkceVerifier');
        answers.push({ status: 'awaitingManual', attemptId: 'attempt-2', secret: 'must-not-pass' });
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: { operation: 'read', attemptId: 'attempt-2' } })).rejects.toThrow();
    });
    it('preserves daemon unavailability as a typed response', async () => {
        answers.push({ status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: beginConnect }))
            .resolves.toEqual({ status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' });
    });
    it('routes strict descriptor/config control through the same exact owner', async () => {
        const described = {
            status: 'described', service,
            descriptor: { id: 'work', title: 'Acme Work', authentication: { defaultModeId: 'manual', modes: [{
                id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }],
            }] } },
            occurrenceId: 'occurrence-1', sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
            accounts: [],
        } satisfies ConnectedAccountDaemonControlResponse;
        answers.push(described);
        const { runConnectedAccountControlCommand, ConnectedAccountDaemonControlResponseSchema } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1', command: { operation: 'describeService', service } })).resolves.toEqual(described);
        expect(outgoing.at(-1)).toMatchObject({ method: 'machine-1:daemon.connectedAccounts.control.command',
            params: { v: 1, machineId: 'machine-1', command: { operation: 'describeService', service } } });
        expect(ConnectedAccountDaemonControlResponseSchema.safeParse({ ...described, generation: 'removed-generation' }).success).toBe(false);
        answers.push({ status: 'unavailable', code: 'connected_account_configuration_target_unavailable', secretRefs: { token: 'must-not-pass' } });
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1', command: {
            operation: 'readConfiguration', target: { kind: 'account', account: { service, accountId: 'account-1' } },
        } })).rejects.toThrow();
    });
    it('routes exact-account revoke through the daemon and accepts only strict settlement responses', async () => {
        const account = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' };
        answers.push({ status: 'revoked', account, remoteStatus: 'remoteUnsupported' });
        const { runConnectedAccountControlCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'revokeAccount', account, cleanupGroupReferences: false } }))
            .resolves.toEqual({ status: 'revoked', account, remoteStatus: 'remoteUnsupported' });
        expect(outgoing.at(-1)).toMatchObject({ params: { command: { operation: 'revokeAccount', account, cleanupGroupReferences: false } } });
        answers.push({ status: 'outcomeUnknown', account, diagnostic: 'must-not-pass' });
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'revokeAccount', account, cleanupGroupReferences: true } })).rejects.toThrow();
    });
});
