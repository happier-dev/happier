import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineDataKeyCacheForTests,
    resolveScopedMachineDataKey,
} from './serverScopedRpcPool';

describe('resolveScopedMachineDataKey', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX;
        resetScopedMachineDataKeyCacheForTests();
    });

    it('fetches and decrypts machine key on first request then uses cache', async () => {
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            json: async () => [
                { id: 'machine-1', dataEncryptionKey: 'encrypted-key' },
            ],
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1, 2, 3]));

        const first = await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toEqual(new Uint8Array([1, 2, 3]));
        expect(second).toEqual(new Uint8Array([1, 2, 3]));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(decryptSpy).toHaveBeenCalledTimes(1);
    });

    it('does not reuse cached machine key when auth token changes', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            const auth = String(init?.headers && (init.headers as any).Authorization ? (init.headers as any).Authorization : '');
            const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
            const dataEncryptionKey = token === 'Aa' ? 'encrypted-key-1' : token === 'BB' ? 'encrypted-key-2' : 'encrypted-key-unknown';
            return {
                ok: true,
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
        const first = await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'Aa',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'BB',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toEqual(new Uint8Array([4, 5, 6]));
        expect(second).toEqual(new Uint8Array([7, 8, 9]));
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(decryptSpy).toHaveBeenCalledTimes(2);
    });

    it('passes an abort signal to fetch for timeout enforcement', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init && 'signal' in init).toBe(true);
            return {
                ok: false,
                json: async () => [],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        const result = await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 1_000,
        });

        expect(result).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest machine keys when cache exceeds EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX = '1';

        const fetchSpy = vi.fn(async () => ({
            ok: true,
            json: async () => [
                { id: 'machine-1', dataEncryptionKey: 'encrypted-key-1' },
                { id: 'machine-2', dataEncryptionKey: 'encrypted-key-2' },
            ],
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async (value: string) => {
            if (value === 'encrypted-key-1') return new Uint8Array([1]);
            if (value === 'encrypted-key-2') return new Uint8Array([2]);
            return new Uint8Array([0]);
        });

        await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-2',
            decryptEncryptionKey: decryptSpy,
        });

        // machine-1 entry should have been evicted (max=1), causing a refetch.
        await resolveScopedMachineDataKey({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
});
