import { MMKV } from 'react-native-mmkv';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The connection runtime (sockets, credentials) is the boundary; the saved-Home owners, the URL
// resolver and the active-server switch above it all run for real.
const switchConnectionToActiveServer = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    switchConnectionToActiveServer,
}));

import {
    getActiveServerSnapshot,
    listServerProfiles,
    resetServerProfilesRuntimeForTests,
    resolveSavedServerProfileByUrl,
} from '@/sync/domains/server/serverProfiles';

import { resolveHomeDisplayNameForRelayUrl as readHomeNameForRelay } from '@/components/settings/server/homeDisplayName';

import { openHomeFromTrayRow } from './trayHome';

/** Seeds the saved Homes at the persistence boundary (the test MMKV), the only way two can share an address. */
function seedSavedHomes(servers: Record<string, Record<string, unknown>>, activeServerId: string) {
    new MMKV().set('server-state-v1', JSON.stringify({ activeServerId, activeServerIdIsExplicit: true, servers }));
    resetServerProfilesRuntimeForTests();
}

const home = (id: string, serverUrl: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...extra });

describe('openHomeFromTrayRow (D11-3, A13-05)', () => {
    const refreshAuth = vi.fn(async () => {});

    beforeEach(() => {
        switchConnectionToActiveServer.mockClear();
        refreshAuth.mockClear();
    });

    it('switches to the one saved Home on that relay, refreshing the app\'s auth', async () => {
        seedSavedHomes({ home: home('home', 'https://home.example.test'), work: home('work', 'https://work.example.test') }, 'home');

        await expect(openHomeFromTrayRow('https://work.example.test/', refreshAuth)).resolves.toBe('opened');

        expect(getActiveServerSnapshot().serverId).toBe('work');
        expect(switchConnectionToActiveServer).toHaveBeenCalled();
        expect(refreshAuth).toHaveBeenCalled();
        expect(readHomeNameForRelay('https://work.example.test')).toBe('work');
    });

    it('registers a Home the app has not saved yet and switches to it (A12-02 parity)', async () => {
        seedSavedHomes({ home: home('home', 'https://home.example.test') }, 'home');

        await expect(openHomeFromTrayRow('https://new.example.test', refreshAuth)).resolves.toBe('opened');

        const saved = listServerProfiles().find((profile) => profile.serverUrl.startsWith('https://new.example.test'));
        expect(saved).toBeDefined();
        expect(getActiveServerSnapshot().serverId).toBe(saved?.id);
    });

    it('picks nothing and names nothing when two saved Homes share that address', async () => {
        seedSavedHomes({
            home: home('home', 'https://home.example.test'),
            first: home('first', 'https://shared.example.test', { serverIdentityId: 'srv_first', canonicalServerUrl: 'https://shared.example.test' }),
            second: home('second', 'https://shared.example.test', { serverIdentityId: 'srv_second', canonicalServerUrl: 'https://shared.example.test' }),
        }, 'home');
        expect(resolveSavedServerProfileByUrl('https://shared.example.test').kind).toBe('ambiguous');

        await expect(openHomeFromTrayRow('https://shared.example.test', refreshAuth)).resolves.toBe('ambiguous');

        expect(getActiveServerSnapshot().serverId).toBe('home');
        expect(switchConnectionToActiveServer).not.toHaveBeenCalled();
        expect(readHomeNameForRelay('https://shared.example.test')).toBeNull();
    });
});
