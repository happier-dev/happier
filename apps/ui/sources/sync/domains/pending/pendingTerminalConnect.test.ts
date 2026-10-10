import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromRecord, toRecord } from './pendingTerminalConnect.shared';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Collect the real Account/Sync graph before the persistence cases begin;
// cold transformation is not part of the pending-capture contract.
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const accountConnections: Array<Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>>> = [];

async function importPendingOwner(options: Readonly<{ restart?: boolean }> = {}) {
    // Ordinary cases exercise one live Sync/Account lifecycle. Only the
    // persistence-reload contract needs a cold module graph.
    if (options.restart) vi.resetModules();
    return await import('./pendingTerminalConnect');
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary();
    const connection = await restoreServerAccountForTest({ serverUrl, accountId });
    accountConnections.push(connection);
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: connection.serverId, accountId });
}

describe('pendingTerminalConnect', () => {
    afterEach(async () => {
        const { clearPendingTerminalConnect } = await import('./pendingTerminalConnect');
        clearPendingTerminalConnect();
        for (const connection of accountConnections.splice(0).reverse()) await connection.dispose();
        vi.restoreAllMocks();
    });

    it('rejects missing or malformed stable Home identity in pending state', () => {
        expect(toRecord({
            publicKeyB64Url: 'key',
            serverUrl: 'https://stack.example.test',
        } as never)).toBeNull();
        expect(toRecord({
            publicKeyB64Url: 'key',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'not a stable identity',
        })).toBeNull();
        expect(fromRecord({
            publicKeyB64Url: 'key',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'not a stable identity',
            createdAtMs: Date.now(),
        })).toBeNull();
    });

    it('rejects a pending record after its pairing deadline', () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        expect(fromRecord({
            publicKeyB64Url: 'key',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: now - 60_000,
                expiresAtMs: now - 1,
            },
            createdAtMs: now - 60_000,
        })).toBeNull();
    });

    it('captures before authentication and promotes only to the target server account on native storage', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importPendingOwner();
        setPendingTerminalConnect({
            publicKeyB64Url: 'native-pre-auth-key',
            serverUrl: 'https://native-target.example.test',
            serverIdentityId: 'srv_native_target',
        });

        await activateServerAccount('https://other.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toBeNull();
        await activateServerAccount('https://native-target.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'native-pre-auth-key' });
        await activateServerAccount('https://native-target.example.test', 'account-b');
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('cancels a native pre-auth capture before any account can claim it', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importPendingOwner();
        setPendingTerminalConnect({
            publicKeyB64Url: 'cancel-native-key',
            serverUrl: 'https://cancel-native.example.test',
            serverIdentityId: 'srv_cancel_native',
        });
        clearPendingTerminalConnect();
        await activateServerAccount('https://cancel-native.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('retargets an unclaimed native pre-auth capture through the storage owner', async () => {
        const {
            setPendingTerminalConnect,
            getPendingTerminalConnect,
            retargetPendingTerminalConnectToServerUrl,
        } = await importPendingOwner();
        setPendingTerminalConnect({
            publicKeyB64Url: 'native-retarget-key',
            serverUrl: 'https://native-old.example.test',
            serverIdentityId: 'srv_native_target',
        });
        await activateServerAccount('https://native-new.example.test', 'account-a');
        retargetPendingTerminalConnectToServerUrl('https://native-new.example.test');
        expect(getPendingTerminalConnect()).toMatchObject({
            publicKeyB64Url: 'native-retarget-key',
            serverUrl: 'https://native-new.example.test',
        });
    });

    it('keeps a failed native promotion claimed to its first account', async () => {
        const pending = await importPendingOwner();
        const { MMKV } = await import('react-native-mmkv');
        const originalSet = MMKV.prototype.set;
        const setSpy = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof MMKV>, key, value) {
            if (key.startsWith('record:v2:')) throw new Error('scoped write unavailable');
            return originalSet.call(this, key, value);
        });
        try {
            pending.setPendingTerminalConnect({
                publicKeyB64Url: 'native-claimed-key',
                serverUrl: 'https://native-claimed.example.test',
                serverIdentityId: 'srv_native_claimed',
            });
            await activateServerAccount('https://native-claimed.example.test', 'account-a');
            expect(pending.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'native-claimed-key' });

            await activateServerAccount('https://native-claimed.example.test', 'account-b');
            expect(pending.getPendingTerminalConnect()).toBeNull();
        } finally {
            setSpy.mockRestore();
        }
    });

    it('invalidates a native unclaimed capture when persisting its account claim fails', async () => {
        const pending = await importPendingOwner();
        const { MMKV } = await import('react-native-mmkv');
        const originalSet = MMKV.prototype.set;
        const setSpy = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof MMKV>, key, value) {
            if (key.startsWith('record:v2:') || (key === 'record:pre-auth:v1' && String(value).includes('claimedScope'))) {
                throw new Error('claim persistence unavailable');
            }
            return originalSet.call(this, key, value);
        });
        try {
            pending.setPendingTerminalConnect({
                publicKeyB64Url: 'native-claim-write-failed-key',
                serverUrl: 'https://native-claim-write-failed.example.test',
                serverIdentityId: 'srv_native_claim_write_failed',
            });
            await activateServerAccount('https://native-claim-write-failed.example.test', 'account-a');
            expect(pending.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'native-claim-write-failed-key' });
        } finally {
            setSpy.mockRestore();
        }

        const reloaded = await importPendingOwner({ restart: true });
        await activateServerAccount('https://native-claim-write-failed.example.test', 'account-b');
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('keeps owner operations nonthrowing when native persistence reads fail', async () => {
        const pending = await importPendingOwner();
        const { MMKV } = await import('react-native-mmkv');
        const originalGetString = MMKV.prototype.getString;
        const getSpy = vi.spyOn(MMKV.prototype, 'getString').mockImplementation(function (this: InstanceType<typeof MMKV>, key) {
            if (key === 'record' || key.startsWith('record:')) throw new Error('native storage unavailable');
            return originalGetString.call(this, key);
        });
        try {
            expect(() => pending.getPendingTerminalConnect()).not.toThrow();
            expect(() => pending.clearPendingTerminalConnect()).not.toThrow();
        } finally {
            getSpy.mockRestore();
        }
    });

    it('round-trips a pending terminal connect payload', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importPendingOwner();

        await activateServerAccount('https://stack.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toBeNull();

        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            supportsTokenOnly: true,
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
            },
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            supportsTokenOnly: true,
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
            },
        });
    });

    it('round-trips the strict V4 Home descriptor without weakening its identity binding', async () => {
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_v4_pending',
            canonicalServerUrl: 'https://home.example.test',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const pending = {
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            serverUrl: 'https://home.example.test',
            serverIdentityId: 'srv_v4_pending',
            pairing: {
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
            },
            supportsTokenOnly: true as const,
            homeConnectionDescriptor: descriptor,
        };

        expect(fromRecord({ ...pending, createdAtMs: Date.now() })).toEqual(pending);
        expect(toRecord({
            ...pending,
            serverIdentityId: 'srv_other_home',
        })).toBeNull();
        expect(toRecord({
            ...pending,
            serverUrl: 'https://different-home.example.test',
        })).toBeNull();
        expect(fromRecord({
            ...pending,
            serverUrl: 'https://different-home.example.test',
            createdAtMs: Date.now(),
        })).toBeNull();
    });

    it('expires stale pending payloads', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importPendingOwner();

        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
        });
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps pending payloads isolated by active server', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importPendingOwner();

        await activateServerAccount('https://server-a.example.test', 'account-a');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
            serverIdentityId: 'srv_a',
        });

        await activateServerAccount('https://server-b.example.test', 'account-a');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
            serverIdentityId: 'srv_b',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
            serverIdentityId: 'srv_b',
        });

        await activateServerAccount('https://server-a.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
            serverIdentityId: 'srv_a',
        });
    });

    it('keeps pending payloads isolated by active account on the same server', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importPendingOwner();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });
    });

    it('absorbs a host-derived scoped terminal connect into an identity scope', async () => {
        const {
            getPendingTerminalConnect,
            migratePendingTerminalConnectScopes,
            setPendingTerminalConnect,
        } = await importPendingOwner();
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const { storage } = await import('@/sync/domains/state/storage');

        await activateServerAccount('https://identity-terminal.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-identity',
            serverUrl: 'https://identity-terminal.example.test',
            serverIdentityId: 'srv_identity_terminal',
        });

        await setServerProfileIdentityForUrl('https://identity-terminal.example.test', 'srv_identity_terminal');
        const legacyScope = createServerAccountScope('identity-terminal.example.test', 'account-a');
        const identityScope = createServerAccountScope('srv_identity_terminal', 'account-a');
        expect(legacyScope).not.toBeNull();
        expect(identityScope).not.toBeNull();
        if (!legacyScope || !identityScope) throw new Error('Terminal migration fixture must have both Account scopes');
        storage.getState().activateProfileScope(identityScope);
        expect(storage.getState().profileScope).toEqual(identityScope);

        migratePendingTerminalConnectScopes(identityScope, [legacyScope]);

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-identity',
            serverUrl: 'https://identity-terminal.example.test',
            serverIdentityId: 'srv_identity_terminal',
        });
        storage.getState().activateProfileScope(legacyScope);
        expect(storage.getState().profileScope).toEqual(legacyScope);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('retains a valid legacy scope when its canonical migration write fails', async () => {
        const { createPendingTerminalConnectOwner } = await import('./pendingTerminalConnect.owner');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const legacyScope = createServerAccountScope('legacy.example.test', 'account-a')!;
        const canonicalScope = createServerAccountScope('srv_canonical', 'account-a')!;
        const values = new Map<string, string>();
        const key = (value: typeof legacyScope) => `${value.serverId}:${value.accountId}`;
        values.set(key(legacyScope), JSON.stringify(toRecord({
            publicKeyB64Url: 'migration-write-failure-key',
            serverUrl: 'https://legacy.example.test',
            serverIdentityId: 'srv_canonical',
        })));
        const owner = createPendingTerminalConnectOwner({
            readPreAuth: () => null,
            writePreAuth: () => true,
            clearPreAuth: () => {},
            readScoped: (value) => values.get(key(value)) ?? null,
            writeScoped: (value, record) => {
                if (value.serverId === canonicalScope.serverId) return false;
                values.set(key(value), record);
                return true;
            },
            clearScoped: (value) => { values.delete(key(value)); },
            readLegacy: () => null,
            clearLegacy: () => {},
        });

        owner.migratePendingTerminalConnectScopes(canonicalScope, [legacyScope]);

        expect(values.has(key(legacyScope))).toBe(true);
        expect(values.has(key(canonicalScope))).toBe(false);
    });
});
