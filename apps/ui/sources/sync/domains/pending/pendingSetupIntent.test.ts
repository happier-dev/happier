import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageState } from '@/sync/store/types';
import { buildDismissedThisComputerSetupIntent } from './pendingSetupIntent.shared';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingSetupIntent');
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

async function activateServerWithoutAccount(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    registerStorageStateReader(() => ({ profileScope: null } as unknown as StorageState));
}

describe('pendingSetupIntent', () => {
    it('builds the canonical dismissed this-computer intent with normalized relay identity', () => {
        expect(buildDismissedThisComputerSetupIntent('  https://relay.example.test///  ')).toEqual({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });
        expect(buildDismissedThisComputerSetupIntent(null)).toEqual({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: null,
        });
    });

    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFresh();
        clearPendingSetupIntent();
        vi.restoreAllMocks();
    });

    it('round-trips and clears a pending setup intent payload', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.example.test', 'account-a');
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

    it('expires and removes a pending setup intent older than the TTL', async () => {
        const writtenAtMs = 1_700_000_000_000;
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(writtenAtMs);
        const { getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.example.test', 'account-a');
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });
        expect(getPendingSetupIntent()).not.toBeNull();

        nowSpy.mockReturnValue(writtenAtMs + (24 * 60 * 60 * 1000) + 1);
        expect(getPendingSetupIntent()).toBeNull();

        nowSpy.mockReturnValue(writtenAtMs);
        const reloaded = await importFresh();
        await activateServerAccount('https://relay.example.test', 'account-a');
        expect(reloaded.getPendingSetupIntent()).toBeNull();
    });

    it('returns a stable pending setup intent reference while the serialized record is unchanged', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        const first = getPendingSetupIntent();
        const second = getPendingSetupIntent();

        expect(first).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(second).toBe(first);
    });

    it('notifies subscribers when pending setup intent storage changes', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent } = await importFresh();
        const { subscribePendingSetupIntent } = await import('./pendingSetupIntent.shared');
        const listener = vi.fn();

        await activateServerAccount('https://relay.example.test', 'account-a');
        const unsubscribe = subscribePendingSetupIntent(listener);

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });
        clearPendingSetupIntent();
        unsubscribe();

        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('round-trips a pending setup intent before an account scope exists', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerWithoutAccount('https://relay.example.test');
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
    });

    it('keeps an unauthenticated pending setup intent readable after account scope appears', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerWithoutAccount('https://relay.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        await activateServerAccount('https://relay.example.test', 'account-a');

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('debug-logs and drops an unauthenticated pending setup intent when auth lands on a different relay URL', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        await activateServerWithoutAccount('https://relay-a.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay-a.example.test/',
        });

        await activateServerAccount('https://relay-b.example.test', 'account-a');

        expect(getPendingSetupIntent()).toBeNull();
        expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('[pendingSetupIntent] dropped server-scoped setup intent'));

        await activateServerWithoutAccount('https://relay-a.example.test');
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a dismissed onboarding marker', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.example.test', 'account-a');
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

        await activateServerAccount('https://relay.remote.example.test', 'account-a');
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

        await activateServerAccount('https://relay.remote.example.test', 'account-a');
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

        await activateServerAccount('https://setup-a.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });

        await activateServerAccount('https://setup-b.example.test', 'account-a');
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

        await activateServerAccount('https://setup-a.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });
    });

    it('keeps setup intent payloads isolated by active account on the same server', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
            remoteSetupIntent: 'remoteMachine',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
            remoteSetupIntent: 'remoteMachine',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });
    });

    it('absorbs a host-derived scoped setup intent into an identity scope', async () => {
        const {
            getPendingSetupIntent,
            migratePendingSetupIntentScopes,
            setPendingSetupIntent,
        } = await importFresh();
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

        await activateServerAccount('https://identity-setup.example.test', 'account-a');
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://identity-setup.example.test',
        });

        setServerProfileIdentityForUrl('https://identity-setup.example.test', 'srv_identity_setup');
        const legacyScope = createServerAccountScope('identity-setup.example.test', 'account-a');
        const identityScope = createServerAccountScope('srv_identity_setup', 'account-a');
        expect(legacyScope).not.toBeNull();
        expect(identityScope).not.toBeNull();
        registerStorageStateReader(() => ({ profileScope: identityScope } as unknown as StorageState));

        migratePendingSetupIntentScopes(identityScope!, [legacyScope!]);

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://identity-setup.example.test',
        });
        registerStorageStateReader(() => ({ profileScope: legacyScope } as unknown as StorageState));
        expect(getPendingSetupIntent()).toBeNull();
    });
});
