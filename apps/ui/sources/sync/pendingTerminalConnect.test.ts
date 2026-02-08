import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingTerminalConnect');
}

describe('pendingTerminalConnect', () => {
    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFresh();
        clearPendingTerminalConnect();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFresh();

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
});
