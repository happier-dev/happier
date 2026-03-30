import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingSetupIntent');
}

describe('pendingSetupIntent', () => {
    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFresh();
        clearPendingSetupIntent();
        vi.restoreAllMocks();
    });

    it('round-trips and clears a pending setup intent payload', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

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

        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test/',
            machineId: 'machine-remote-1',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });
});
