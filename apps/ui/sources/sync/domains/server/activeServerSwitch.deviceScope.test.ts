import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/http/client', () => ({
    abortServerFetches: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
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
});
