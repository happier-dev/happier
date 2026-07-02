import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'srv_identity',
    serverUrl: 'https://relay.example.test',
    generation: 0,
}));

const storageState = vi.hoisted(() => ({
    profileScope: null as null | { serverId: string; accountId: string },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/state/storageStateReaderBridge', () => ({
    readRegisteredStorageState: () => storageState,
}));

describe('getActiveServerAccountScope', () => {
    beforeEach(() => {
        activeServerSnapshot.serverId = 'srv_identity';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.generation = 0;
        storageState.profileScope = null;
    });

    it('returns the active scope when both the snapshot and stored scope use the identity id', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-1' };

        const { getActiveServerAccountScope } = await import('./activeServerAccountScope');

        expect(getActiveServerAccountScope()).toEqual({
            serverId: 'srv_identity',
            accountId: 'account-1',
        });
    });

    it('does not treat a legacy host-derived scope as active after the snapshot resolves to identity', async () => {
        storageState.profileScope = { serverId: 'localhost-18829', accountId: 'account-1' };

        const { getActiveServerAccountScope } = await import('./activeServerAccountScope');

        expect(getActiveServerAccountScope()).toBeNull();
    });
});
