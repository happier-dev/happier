import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineDataKeyCacheForTests,
    resolveScopedMachineDataKey,
} from './serverScopedRpcPool';
import {
    resetScopedSessionDataKeyCacheForTests,
    resolveScopedSessionDataKey,
} from './resolveScopedSessionDataKey';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

function isReachabilityProbe(input: unknown): boolean {
    const url = String(input ?? '');
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
}

function reachabilityOk() {
    return { ok: true, status: 200, json: async () => ({}) };
}

function sessionByIdBody(sessionId: string, dataEncryptionKey: string) {
    return {
        session: {
            id: sessionId,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: 'metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey,
        },
    };
}

function countCalls(match: string): number {
    return runtimeFetchMock.mock.calls.filter(([input]) => String(input).includes(match)).length;
}

describe('scoped data-key resolution coalesces concurrent callers', () => {
    afterEach(async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX;
        delete process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX;
        runtimeFetchMock.mockReset();
        resetScopedMachineDataKeyCacheForTests();
        resetScopedSessionDataKeyCacheForTests();
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
    });

    it('opens the machine data-key envelope once for a burst of concurrent probes', async () => {
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            return {
                ok: true,
                status: 200,
                json: async () => [{ id: 'machine-1', dataEncryptionKey: 'envelope-1' }],
            };
        });
        const decrypt = vi.fn(async () => new Uint8Array([1, 2, 3]));

        // The new-session screen fires ~8-10 capability preflight probes against one
        // machine at once; every one of them resolves the same machine data key.
        const results = await Promise.all(Array.from({ length: 8 }, () => resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decrypt,
        })));

        for (const result of results) {
            expect(result).toEqual(new Uint8Array([1, 2, 3]));
        }
        expect(decrypt).toHaveBeenCalledTimes(1);
        expect(countCalls('/v1/machines')).toBe(1);
    });

    it('keeps concurrent machine keys separate per machine id', async () => {
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            return {
                ok: true,
                status: 200,
                json: async () => [
                    { id: 'machine-1', dataEncryptionKey: 'envelope-1' },
                    { id: 'machine-2', dataEncryptionKey: 'envelope-2' },
                ],
            };
        });
        const decrypt = vi.fn(async (value: string) => (
            value === 'envelope-1' ? new Uint8Array([1]) : new Uint8Array([2])
        ));

        const [first, second, third, fourth] = await Promise.all([
            resolveScopedMachineDataKey({
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                token: 'token-b',
                machineId: 'machine-1',
                decryptEncryptionKey: decrypt,
            }),
            resolveScopedMachineDataKey({
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                token: 'token-b',
                machineId: 'machine-2',
                decryptEncryptionKey: decrypt,
            }),
            resolveScopedMachineDataKey({
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                token: 'token-b',
                machineId: 'machine-1',
                decryptEncryptionKey: decrypt,
            }),
            resolveScopedMachineDataKey({
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                token: 'token-b',
                machineId: 'machine-2',
                decryptEncryptionKey: decrypt,
            }),
        ]);

        expect(first).toEqual(new Uint8Array([1]));
        expect(third).toEqual(new Uint8Array([1]));
        expect(second).toEqual(new Uint8Array([2]));
        expect(fourth).toEqual(new Uint8Array([2]));
        expect(decrypt).toHaveBeenCalledTimes(2);
    });

    it('does not retain a failed machine-key resolution for later callers', async () => {
        let machineListCalls = 0;
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            machineListCalls += 1;
            if (machineListCalls === 1) {
                return { ok: false, status: 500, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => [{ id: 'machine-1', dataEncryptionKey: 'envelope-1' }],
            };
        });
        const decrypt = vi.fn(async () => new Uint8Array([7]));

        const request = () => resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decrypt,
            timeoutMs: 50,
        });

        // The failing burst is coalesced into a single attempt...
        const failed = await Promise.all([request(), request(), request()]);
        expect(failed).toEqual([null, null, null]);
        expect(machineListCalls).toBe(1);

        // ...and a failure is never retained, so the next caller retries for real.
        await expect(request()).resolves.toEqual(new Uint8Array([7]));
        expect(machineListCalls).toBe(2);
    });

    it('opens the session data-key envelope once for concurrent scoped session callers', async () => {
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            return { ok: true, status: 200, json: async () => sessionByIdBody('session-1', 'k1') };
        });
        const decrypt = vi.fn(async () => new Uint8Array([9, 9]));

        const results = await Promise.all(Array.from({ length: 6 }, () => resolveScopedSessionDataKey({
            serverId: 's-id',
            serverUrl: 'https://server.example.test',
            token: 'token',
            sessionId: 'session-1',
            decryptEncryptionKey: decrypt,
        })));

        for (const result of results) {
            expect(result).toEqual(new Uint8Array([9, 9]));
        }
        expect(decrypt).toHaveBeenCalledTimes(1);
        expect(countCalls('/v2/sessions/session-1')).toBe(1);
    });

    it('keeps concurrent session keys separate per session id', async () => {
        runtimeFetchMock.mockImplementation(async (input: unknown) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            const url = String(input ?? '');
            const sessionId = url.includes('session-2') ? 'session-2' : 'session-1';
            return {
                ok: true,
                status: 200,
                json: async () => sessionByIdBody(sessionId, sessionId === 'session-2' ? 'k2' : 'k1'),
            };
        });
        const decrypt = vi.fn(async (value: string) => (
            value === 'k2' ? new Uint8Array([2]) : new Uint8Array([1])
        ));

        const request = (sessionId: string) => resolveScopedSessionDataKey({
            serverId: 's-id',
            serverUrl: 'https://server.example.test',
            token: 'token',
            sessionId,
            decryptEncryptionKey: decrypt,
        });

        const [a, b, c, d] = await Promise.all([
            request('session-1'),
            request('session-2'),
            request('session-1'),
            request('session-2'),
        ]);

        expect(a).toEqual(new Uint8Array([1]));
        expect(c).toEqual(new Uint8Array([1]));
        expect(b).toEqual(new Uint8Array([2]));
        expect(d).toEqual(new Uint8Array([2]));
        expect(decrypt).toHaveBeenCalledTimes(2);
    });

    it('keeps machine token eviction from invalidating the session cache identity', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX = '1';
        process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SESSION_KEY_CACHE_MAX = '2';
        runtimeFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
            if (isReachabilityProbe(input)) return reachabilityOk();
            if (String(input).includes('/v2/sessions/')) {
                return { ok: true, status: 200, json: async () => sessionByIdBody('session-1', 'session-key') };
            }
            const authorization = new Headers(init?.headers).get('authorization') ?? '';
            return {
                ok: true,
                status: 200,
                json: async () => [{ id: 'machine-1', dataEncryptionKey: `machine-${authorization}` }],
            };
        });
        const decrypt = vi.fn(async () => new Uint8Array([1]));
        const resolveSession = () => resolveScopedSessionDataKey({
            serverId: 'server-1',
            serverUrl: 'https://server.example.test',
            token: 'session-token',
            sessionId: 'session-1',
            decryptEncryptionKey: decrypt,
        });

        await resolveSession();
        for (const token of ['machine-token-a', 'machine-token-b']) {
            await resolveScopedMachineDataKey({
                serverId: 'server-1',
                serverUrl: 'https://server.example.test',
                token,
                machineId: 'machine-1',
                decryptEncryptionKey: decrypt,
            });
        }
        await resolveSession();

        expect(countCalls('/v2/sessions/session-1')).toBe(1);
    });
});
