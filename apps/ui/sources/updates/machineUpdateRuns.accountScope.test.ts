import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ScopedMachineEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { UpdateItem } from './items/updateItem';

const boundary = vi.hoisted(() => ({
    credentials: null as AuthCredentials | null,
    encryption: null as ScopedMachineEncryption | null,
    invoke: vi.fn<(accountId: string, request: CapabilitiesInvokeRequest) => Promise<unknown>>(),
}));

// Persisted authentication and machine transports are genuine system boundaries. The batch,
// capability parser, scoped credential resolver and RPC/encryption orchestration stay real.
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: async (_machineId: string, method: string, request: CapabilitiesInvokeRequest) => {
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {} };
            const { parseToken } = await import('@/utils/auth/parseToken');
            return boundary.invoke(parseToken(boundary.credentials!.token), request);
        },
    },
}));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: async () => new Response(JSON.stringify({ machine: { id: 'studio', dataEncryptionKey: null } })),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: async ({ token }: { token: string }) => {
        const emitWithAck = async (_event: string, payload: { method: string; params: string }) => {
            if (payload.method.endsWith(':capabilities.detect')) {
                return { ok: true, result: await boundary.encryption!.encryptRaw({ protocolVersion: 1, results: {} }) };
            }
            const { parseToken } = await import('@/utils/auth/parseToken');
            const request = await boundary.encryption!.decryptRaw(payload.params) as CapabilitiesInvokeRequest;
            const result = await boundary.invoke(parseToken(token), request);
            return { ok: true, result: await boundary.encryption!.encryptRaw(result) };
        };
        return { timeout: () => ({ emitWithAck }), emitWithAck, emit: vi.fn(), disconnect: vi.fn() };
    },
}));

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { runUpdateBatch, runMachineItemUpdate, readMachineUpdateRuns, observeMachineUpdateRun } from './machineUpdateRuns';

function credentials(accountId: string): AuthCredentials {
    return { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`, secret: Buffer.alloc(32, 7).toString('base64url') };
}

function item(id: string, subject: UpdateItem['subject']): UpdateItem {
    return {
        id, subject, machineId: 'studio', title: id, currentVersion: '1', latestVersion: '2',
        state: 'available', progressPercent: null, step: null, managedBy: 'happier',
        action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
    };
}

describe('machine update account scope at the real RPC credential boundary', () => {
    let scope: { serverId: string; accountId: string };
    beforeEach(async () => {
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => boundary.credentials);
        const profile = await upsertAndActivateServer({ serverUrl: 'https://updates-account-scope.example.test' });
        scope = { serverId: profile.id, accountId: 'account-a' };
        boundary.credentials = credentials('account-a');
        const encryption = await createEncryptionFromAuthCredentials(boundary.credentials);
        await encryption.initializeMachines(new Map([['studio', null]]));
        boundary.encryption = encryption.getMachineEncryption('studio');
        boundary.invoke.mockReset();
        vi.useFakeTimers();
    });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it.each(['happier-cli', 'installable'] as const)('rejects a queued %s update after same-server account replacement', async (kind) => {
        const first = item(`first-${kind}`, { kind: 'installable', key: 'gh' });
        const second = item(`second-${kind}`, kind === 'happier-cli' ? { kind } : { kind, key: 'gh' });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const firstIssued = new Promise<void>((resolve) => { entered = resolve; });
        boundary.invoke.mockImplementation(async (_accountId, request) => {
            entered();
            await pending;
            return request.method === 'start'
                ? { ok: true, result: { taskId: 'task-queued' } }
                : { ok: true, result: request.method === 'poll' ? { result: { ok: true } } : {} };
        });
        const running = runUpdateBatch(scope, [first, second], (update) => runMachineItemUpdate(update, { scope }));
        await firstIssued;
        boundary.credentials = credentials('account-b');
        release();
        await running;

        expect(boundary.invoke.mock.calls.map(([accountId]) => accountId)).toEqual(['account-a']);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), second.id)).toMatchObject({
            running: false, errorMessage: expect.any(String),
        });
    });

    it('admits the remote CLI update when start and poll retain the initiating account', async () => {
        const cli = item('cli-retained-account', { kind: 'happier-cli' });
        boundary.invoke.mockImplementation(async (_accountId, request) => ({
            ok: true, result: request.method === 'poll' ? { result: { ok: true } } : { taskId: 'task-retained' },
        }));
        await runUpdateBatch(scope, [cli], (update) => runMachineItemUpdate(update, { scope }));

        expect(boundary.invoke.mock.calls.map(([accountId, request]) => [accountId, request.method])).toEqual([
            ['account-a', 'start'], ['account-a', 'poll'],
        ]);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), cli.id)).toMatchObject({
            running: true, errorMessage: null,
        });
    });

    it('reports an unknown outcome without polling through replacement-account credentials', async () => {
        const cli = item('cli-start-poll-account', { kind: 'happier-cli' });
        boundary.invoke.mockImplementation(async (_accountId, request) => {
            boundary.credentials = credentials('account-b');
            return { ok: true, result: request.method === 'poll' ? { result: { ok: true } } : { taskId: 'task-started' } };
        });
        await runUpdateBatch(scope, [cli], (update) => runMachineItemUpdate(update, { scope }));

        expect(boundary.invoke.mock.calls.map(([accountId, request]) => [accountId, request.method])).toEqual([['account-a', 'start']]);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), cli.id)).toMatchObject({
            running: false, errorMessage: expect.any(String),
        });
    });
});
