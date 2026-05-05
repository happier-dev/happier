import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingTerminalConnect');
}

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

describe('pendingTerminalConnect', () => {
    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFresh();
        clearPendingTerminalConnect();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFresh();

        await activateServer('https://stack.example.test');
        expect(getPendingTerminalConnect()).toBeNull();

        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('expires stale pending payloads', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFresh();

        await activateServer('https://stack.example.test');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps pending payloads isolated by active server', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importFresh();

        await activateServer('https://server-a.example.test');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
        });

        await activateServer('https://server-b.example.test');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
        });

        await activateServer('https://server-a.example.test');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
        });
    });
});
