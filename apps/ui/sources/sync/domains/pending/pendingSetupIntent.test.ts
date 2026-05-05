import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingSetupIntent');
}

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

describe('pendingSetupIntent', () => {
    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFresh();
        clearPendingSetupIntent();
        vi.restoreAllMocks();
    });

    it('round-trips and clears a pending setup intent payload', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServer('https://relay.example.test');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a dismissed onboarding marker', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServer('https://relay.example.test');
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a remote machine resume intent', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServer('https://relay.remote.example.test');
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test/',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteMachine',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteMachine',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a remote relay-host resume intent', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServer('https://relay.remote.example.test');
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test/',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteRelayHost',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteRelayHost',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('keeps setup intent payloads isolated by active server', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServer('https://setup-a.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });

        await activateServer('https://setup-b.example.test');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-b.example.test',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-b.example.test',
        });

        await activateServer('https://setup-a.example.test');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });
    });
});
