import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineDataKeyCacheForTests,
    resolveScopedMachineEncryptionContext,
} from './serverScopedRpcPool';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

function readAuthorizationHeader(headers: RequestInit['headers']): string {
    if (!headers) return '';
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get('Authorization') ?? '';
    }
    if (Array.isArray(headers)) {
        const entry = headers.find(([name]) => String(name).toLowerCase() === 'authorization');
        return entry ? String(entry[1] ?? '') : '';
    }
    const record = headers as Record<string, string>;
    return String(record.Authorization ?? record.authorization ?? '');
}

describe('resolveScopedMachineEncryptionContext', () => {
    it('revalidates a cached encrypted key when a machine changes to plain content and back', async () => {
        let dataEncryptionKey = 'encrypted-key';
        vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
            ok: true, status: 200,
            json: async () => url.includes('/v1/machines')
                ? [{ id: 'machine-1', dataEncryptionKey }]
                : url.includes('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 } : {},
        })));
        const decrypt = vi.fn(async () => new Uint8Array([1]));
        const resolve = () => resolveScopedMachineEncryptionContext({ serverId: 'server-b', serverUrl: 'https://server-b.example.test',
            token: 'token-b', machineId: 'machine-1', decryptEncryptionKey: decrypt });
        await expect(resolve()).resolves.toEqual({ mode: 'encrypted', dataKey: new Uint8Array([1]) });
        dataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
        await expect(resolve()).resolves.toEqual({ mode: 'plain' });
        dataEncryptionKey = 'rotated-encrypted-key';
        await expect(resolve()).resolves.toEqual({ mode: 'encrypted', dataKey: new Uint8Array([1]) });
        expect(decrypt).toHaveBeenCalledTimes(2);
    });

    it('rejects a present empty machine key rather than selecting legacy encryption', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
            ok: true, status: 200,
            json: async () => url.includes('/v1/machines') ? [{ id: 'machine-1', dataEncryptionKey: '' }] : {},
        })));
        await expect(resolveScopedMachineEncryptionContext({ serverId: 'server-b', serverUrl: 'https://server-b.example.test',
            token: 'token-b', machineId: 'machine-1', decryptEncryptionKey: async () => new Uint8Array([1]),
        })).rejects.toMatchObject({ rpcErrorCode: 'machine_rpc_context_unavailable' });
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        delete process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX;
        resetScopedMachineDataKeyCacheForTests();
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
    });

    it('revalidates the machine envelope while reusing its unchanged decrypted key', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => [
                    { id: 'machine-1', dataEncryptionKey: 'encrypted-key' },
                ],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1, 2, 3]));

        const first = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toEqual({ mode: 'encrypted', dataKey: new Uint8Array([1, 2, 3]) });
        expect(second).toEqual({ mode: 'encrypted', dataKey: new Uint8Array([1, 2, 3]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(1);
    });

    it('does not reuse cached machine key when auth token changes', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            if (String(_url).endsWith('/health') || String(_url).endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            // `runtimeFetchWithServerReachability` normalizes init.headers into a Headers
            // instance, so reading an own `Authorization` property finds nothing and this
            // case silently stops discriminating between tokens.
            const auth = readAuthorizationHeader(init?.headers);
            const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
            const dataEncryptionKey = token === 'Aa' ? 'encrypted-key-1' : token === 'BB' ? 'encrypted-key-2' : 'encrypted-key-unknown';
            return {
                ok: true,
                status: 200,
                json: async () => [
                    { id: 'machine-1', dataEncryptionKey },
                ],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async (value: string) => {
            if (value === 'encrypted-key-1') return new Uint8Array([4, 5, 6]);
            if (value === 'encrypted-key-2') return new Uint8Array([7, 8, 9]);
            return new Uint8Array([0]);
        });

        // NOTE: these tokens intentionally collide under the legacy 31-based 32-bit hash:
        // "Aa" and "BB" yield the same hash, which would cause incorrect cache reuse.
        const first = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'Aa',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'BB',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toEqual({ mode: 'encrypted', dataKey: new Uint8Array([4, 5, 6]) });
        expect(second).toEqual({ mode: 'encrypted', dataKey: new Uint8Array([7, 8, 9]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(2);
    });

    it('passes an abort signal to fetch for timeout enforcement', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            if (String(_url).endsWith('/health') || String(_url).endsWith('/v1/auth/ping')) {
                return new Response('{}', { status: 200 });
            }
            if (String(_url).includes('/v1/machines')) {
                expect(init && 'signal' in init).toBe(true);
            }
            return new Response('[]', { status: 503 });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        const result = resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 1_000,
        });

        await expect(result).rejects.toMatchObject({ rpcErrorCode: 'machine_rpc_context_unavailable' });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(1);
    });

    it('retries machine key fetch when the first lookup returns no key', async () => {
        let machineCalls = 0;
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (!url.includes('/v1/machines')) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            machineCalls += 1;
            if (machineCalls === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [
                        { id: 'machine-1', dataEncryptionKey: null },
                    ],
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => [
                    { id: 'machine-1', dataEncryptionKey: 'encrypted-key' },
                ],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([9, 9, 9]));

        const first = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toEqual({ mode: 'encrypted', dataKey: null });
        expect(second).toEqual({ mode: 'encrypted', dataKey: new Uint8Array([9, 9, 9]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest machine keys when cache exceeds EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX = '1';

        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => [
                    { id: 'machine-1', dataEncryptionKey: 'encrypted-key-1' },
                    { id: 'machine-2', dataEncryptionKey: 'encrypted-key-2' },
                ],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async (value: string) => {
            if (value === 'encrypted-key-1') return new Uint8Array([1]);
            if (value === 'encrypted-key-2') return new Uint8Array([2]);
            return new Uint8Array([0]);
        });

        await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-2',
            decryptEncryptionKey: decryptSpy,
        });

        // machine-1 entry should have been evicted (max=1), causing a refetch.
        await resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(3);
    });

    it('does not attempt the machine list request when reachability probes fail (offline)', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.endsWith('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            if (href.includes('/v1/machines')) {
                throw new Error('unexpected machine list request');
            }
            throw new Error(`unexpected fetch url: ${href}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        await expect(resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 50,
        })).rejects.toBeInstanceOf(Error);

        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(0);
        expect(decryptSpy).not.toHaveBeenCalled();
    });

    it('throws terminal auth instead of returning null for scoped machine-key 403 responses', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (href.includes('/v1/machines')) {
                return { ok: false, status: 403, json: async () => ({}) };
            }
            throw new Error(`unexpected fetch url: ${href}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        await expect(resolveScopedMachineEncryptionContext({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 50,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(decryptSpy).not.toHaveBeenCalled();
    });
});
