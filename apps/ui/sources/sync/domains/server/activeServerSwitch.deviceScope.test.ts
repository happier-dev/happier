import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AccountEncryptionFirstKeyCredentialMutationResult,
    AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async () => null));
const guardCredentialMutationSpy = vi.hoisted(() => vi.fn<
    () => Promise<AccountEncryptionFirstKeyCredentialMutationResult>
>(async () => ({ kind: 'allowed' })));
const presentCredentialLifecycleSpy = vi.hoisted(() => vi.fn(async (params: {
    run: () => Promise<
        | { kind: 'completed' }
        | { kind: 'finish_encryption_setup'; recovery: unknown }
        | { kind: 'recovery_failed' }
    >;
    onCompleted?: () => void | Promise<void>;
}) => {
    const result = await params.run();
    if (result.kind === 'completed') {
        await params.onCompleted?.();
    }
}));

vi.mock('@/sync/http/client', () => ({
    abortServerFetches: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
}));

vi.mock('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth', () => ({
    guardAccountEncryptionFirstKeyCredentialMutation: guardCredentialMutationSpy,
}));

vi.mock('@/components/account/presentFirstKeyCredentialLifecycle', () => ({
    presentFirstKeyCredentialLifecycle: presentCredentialLifecycleSpy,
}));

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => void store.clear(),
    });
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('document', {});
}

async function importFreshServerModules() {
    vi.resetModules();
    const [profiles, switches] = await Promise.all([
        import('./serverProfiles'),
        import('./activeServerSwitch'),
    ]);
    return { profiles, switches };
}

describe('activeServerSwitch device scope', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        guardCredentialMutationSpy.mockReset();
        guardCredentialMutationSpy.mockResolvedValue({ kind: 'allowed' });
        presentCredentialLifecycleSpy.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('promotes the current tab active server to the device active server by id', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const deviceProfile = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(deviceProfile.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        const switched = await switches.setActiveServerAndSwitch({
            serverId: tabProfile.id,
            scope: 'device',
        });

        expect(switched).toBe(true);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabProfile.id);
        expect(profiles.getActiveServerId()).toBe(tabProfile.id);
    });

    it('promotes the current tab active server to the device active server by url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const deviceProfile = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(deviceProfile.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        const switched = await switches.upsertActivateAndSwitchServer({
            serverUrl: tabProfile.serverUrl,
            source: 'url',
            scope: 'device',
        });

        expect(switched).toBe(true);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabProfile.id);
        expect(profiles.getActiveServerUrl()).toBe('https://tab.example.test');
    });

    it('does not switch when the target id aliases the active server identity', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_identity_123');

        const switched = await switches.setActiveServerAndSwitch({
            serverId: profile.id,
            scope: 'device',
        });

        expect(switched).toBe(false);
        expect(profiles.getActiveServerId()).toBe('srv_identity_123');
        expect(profiles.getDeviceDefaultServerId()).toBe(profile.id);
    });

    it('keeps active-server, connection, and auth refresh state unchanged until marked custody is adjudicated', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const recovery = {} as AccountEncryptionFirstKeyRecoveryHandle;
        guardCredentialMutationSpy.mockResolvedValue({
            kind: 'finish_encryption_setup',
            recovery,
        });
        const { profiles, switches } = await importFreshServerModules();
        const activeProfile = profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        const targetProfile = profiles.upsertServerProfile({
            serverUrl: 'https://target.example.test',
            name: 'Target',
        });
        profiles.setActiveServerId(activeProfile.id, { scope: 'device' });
        const refreshAuth = vi.fn(async () => {});

        const switched = await switches.setActiveServerAndSwitch({
            serverId: targetProfile.id,
            scope: 'device',
            refreshAuth,
        });

        expect(switched).toBe(false);
        expect(presentCredentialLifecycleSpy).toHaveBeenCalledTimes(1);
        expect(guardCredentialMutationSpy).toHaveBeenCalledTimes(1);
        expect(profiles.getActiveServerId()).toBe(activeProfile.id);
        expect(profiles.getDeviceDefaultServerId()).toBe(activeProfile.id);
        expect(switchConnectionToActiveServerSpy).not.toHaveBeenCalled();
        expect(refreshAuth).not.toHaveBeenCalled();
    });

    it('surfaces retained marked custody after switching to its server', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const recovery = {} as AccountEncryptionFirstKeyRecoveryHandle;
        guardCredentialMutationSpy
            .mockResolvedValueOnce({ kind: 'allowed' })
            .mockResolvedValueOnce({
                kind: 'finish_encryption_setup',
                recovery,
            });
        const { profiles, switches } = await importFreshServerModules();
        const activeProfile = profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        const targetProfile = profiles.upsertServerProfile({
            serverUrl: 'https://retained.example.test',
            name: 'Retained',
        });
        profiles.setActiveServerId(activeProfile.id, { scope: 'device' });

        const switched = await switches.setActiveServerAndSwitch({
            serverId: targetProfile.id,
            scope: 'device',
        });

        expect(switched).toBe(true);
        expect(profiles.getActiveServerId()).toBe(targetProfile.id);
        expect(presentCredentialLifecycleSpy).toHaveBeenCalledTimes(2);
        expect(guardCredentialMutationSpy).toHaveBeenNthCalledWith(2, {
            serverUrl: targetProfile.serverUrl,
            serverId: targetProfile.id,
        });
    });
});
