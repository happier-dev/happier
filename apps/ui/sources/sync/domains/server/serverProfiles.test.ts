import { afterEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';

import { scopedStorageId } from '@/utils/system/storageScope';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
    });
    let hostname = '';
    try {
        hostname = new URL(origin).hostname;
    } catch {
        hostname = '';
    }
    vi.stubGlobal('window', { location: { origin, hostname } });
    vi.stubGlobal('document', {});
}

function stubWebRuntimeWithRuntimeConfig(origin: string, runtimeConfig: Record<string, unknown>) {
    let hostname = '';
    try {
        hostname = new URL(origin).hostname;
    } catch {
        hostname = '';
    }
    vi.stubGlobal('window', {
        location: { origin, hostname },
        __HAPPIER_WEB_RUNTIME_CONFIG__: runtimeConfig,
    });
    vi.stubGlobal('document', {});
}

async function importFresh(options: Readonly<{ resetModules?: boolean }> = {}) {
    if (options.resetModules !== false) vi.resetModules();
    return await import('./serverProfiles');
}

describe('serverProfiles', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const previousServerContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousCanonicalServerUrl = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    const previousServerUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousLegacyGenericServerUrl = process.env.EXPO_PUBLIC_SERVER_URL;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousBuildFeaturesDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousServerContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousServerContext;
        if (previousCanonicalServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previousCanonicalServerUrl;
        if (previousServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousServerUrl;
        if (previousLegacyGenericServerUrl === undefined) delete process.env.EXPO_PUBLIC_SERVER_URL;
        else process.env.EXPO_PUBLIC_SERVER_URL = previousLegacyGenericServerUrl;
        if (previousPreconfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousPreconfigured;
        if (previousBuildFeaturesDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousBuildFeaturesDeny;
    });

    it('prefers sessionStorage activeServerId on web over the device default', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        const created = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        expect(profiles.getActiveServerUrl()).toBe('https://tab.example.test');
    });

    it('returns a stable active server snapshot reference until the store changes', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        const first = profiles.getActiveServerSnapshot();
        const second = profiles.getActiveServerSnapshot();

        expect(second).toBe(first);

        const next = profiles.upsertServerProfile({
            serverUrl: 'https://next.example.test',
            name: 'Next',
        });
        profiles.setActiveServerId(next.id, { scope: 'device' });

        const third = profiles.getActiveServerSnapshot();
        expect(third).not.toBe(first);
        expect(third.serverUrl).toBe('https://next.example.test');
    });

    it('emits an active server refresh when the server profile set changes without changing the selected server', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const active = profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        profiles.setActiveServerId(active.id, { scope: 'device' });

        const first = profiles.getActiveServerSnapshot();
        const listener = vi.fn();
        profiles.subscribeActiveServer(listener);

        profiles.upsertServerProfile({
            serverUrl: 'https://next.example.test',
            name: 'Next',
        });

        const second = profiles.getActiveServerSnapshot();

        expect(second.serverId).toBe(first.serverId);
        expect(second.serverUrl).toBe(first.serverUrl);
        expect(second.generation).toBeGreaterThan(first.generation);
        expect(listener).toHaveBeenCalled();
        expect(listener.mock.calls.at(-1)?.[0].generation).toBe(second.generation);
    });

    it('tracks whether the active server selection is explicit', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        expect(profiles.isActiveServerSelectionExplicit()).toBe(false);

        const created = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.isActiveServerSelectionExplicit()).toBe(true);
    });

    it('emits active server changes when selection becomes explicit without changing the URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('null');

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
        expect(profiles.isActiveServerSelectionExplicit()).toBe(false);

        const listener = vi.fn();
        profiles.subscribeActiveServer(listener);

        profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.isActiveServerSelectionExplicit()).toBe(true);
        expect(listener).toHaveBeenCalled();
    });

    it('persists a shareable relay URL on the active server snapshot', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        profiles.setActiveServerId(created.id, { scope: 'device' });
        profiles.setServerProfileShareableUrl(created.id, 'https://relay.example.ts.net/path?token=abc#frag', {
            validatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        });

        const snapshot = profiles.getActiveServerSnapshot();
        expect(snapshot.activeShareableServerUrl).toBe('https://relay.example.ts.net/path');
        expect(snapshot.activeShareableServerUrlValidatedAgainstServerUrl).toBe('http://127.0.0.1:3005');
        expect(profiles.getActiveServerUrl()).toBe('https://relay.example.test');
    });

    it('exposes device default and tab override server ids separately on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        const device = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tab = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(device.id, { scope: 'device' });
        profiles.setActiveServerId(tab.id, { scope: 'tab' });

        expect(profiles.getActiveServerId()).toBe(tab.id);
        expect(profiles.getDeviceDefaultServerId()).toBe(device.id);
        expect(profiles.getTabActiveServerId()).toBe(tab.id);
    });

    it('seeds Happier Cloud on native when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('does not seed Happier Cloud on native when build policy denies the setup surface policy gate', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowHappierCloud';

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
        expect(profiles.getActiveServerUrl()).not.toBe('https://api.happier.dev');
    });

    it('seeds a same-origin server profile on web when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('https://selfhost.example.test');

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://selfhost.example.test')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://selfhost.example.test');
        expect(profiles.getActiveServerId()).toBeTruthy();
    });

    it('avoids seeding Metro/local UI origins as a relay server in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('http://localhost:8081');

        const profiles = await importFresh();

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://localhost:8081')).toBe(false);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('avoids seeding Metro/local UI origins as a relay server when stack context comes from runtime config', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntimeWithRuntimeConfig('http://127.0.0.1:8081', { serverContext: 'stack' });

        const profiles = await importFresh();

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://127.0.0.1:8081')).toBe(false);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('dedupes loopback-equivalent servers and prefers same-origin on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('http://qa-stack.localhost:24577');

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set(
            'server-state-v1',
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'localhost-24577',
                servers: {
                    'qa-stack.localhost-24577': {
                        id: 'qa-stack.localhost-24577',
                        name: 'Stack',
                        serverUrl: 'http://qa-stack.localhost:24577/',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 200,
                        source: 'url',
                    },
                    'localhost-24577': {
                        id: 'localhost-24577',
                        name: 'Local',
                        serverUrl: 'http://localhost:24577/',
                        createdAt: 150,
                        updatedAt: 250,
                        lastUsedAt: 250,
                        source: 'url',
                    },
                },
            }),
        );

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.length).toBe(1);
        expect(profiles.getActiveServerUrl()).toBe('http://qa-stack.localhost:24577');
        expect(profiles.getActiveServerId()).toBe('qa-stack.localhost-24577');
    });

    it('dedupes equivalent servers without rewriting the explicit active server id when no same-origin override exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set(
            'server-state-v1',
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'manual-id',
                servers: {
                    'manual-id': {
                        id: 'manual-id',
                        name: 'Manual Active',
                        serverUrl: 'https://api.example.test',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 999,
                        source: 'manual',
                    },
                    'stack-id': {
                        id: 'stack-id',
                        name: 'Stack Seeded',
                        serverUrl: 'https://api.example.test',
                        createdAt: 150,
                        updatedAt: 250,
                        lastUsedAt: 0,
                        source: 'stack-env',
                    },
                },
            }),
        );

        const profiles = await importFresh();
        expect(profiles.listServerProfiles()).toHaveLength(1);
        expect(profiles.getActiveServerUrl()).toBe('https://api.example.test');
        expect(profiles.getActiveServerId()).toBe('manual-id');
    });

    it('uses a stored server identity as the active durable scope id while preserving the profile id', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);

        profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_identity_123');

        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: 'srv_identity_123',
            serverUrl: 'https://relay.example.test',
        });
        expect(profiles.getActiveServerId()).toBe('srv_identity_123');
        expect(profiles.getDeviceDefaultServerScopeId()).toBe('srv_identity_123');
        expect(profiles.resolveServerProfileScopeIdForIdentifier(created.id)).toBe('srv_identity_123');
        expect(profiles.resolveServerProfileScopeIdForIdentifier('srv_identity_123')).toBe('srv_identity_123');
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'srv_identity_123')).toBe(true);
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'missing-server')).toBe(false);
        expect(profiles.getServerProfileById('srv_identity_123')?.id).toBe(created.id);
        expect(profiles.getServerProfileLegacyServerIds('srv_identity_123')).toContain(created.id);
    });

    it('preserves a previous server identity as a legacy alias when the same profile learns a new identity', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_old_identity');
        profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_new_identity');

        expect(profiles.getActiveServerSnapshot().serverId).toBe('srv_new_identity');
        expect(profiles.resolveServerProfileScopeIdForIdentifier('srv_old_identity')).toBe('srv_new_identity');
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'srv_old_identity')).toBe(true);
        expect(profiles.areServerProfileIdentifiersEquivalent('srv_old_identity', 'srv_new_identity')).toBe(true);
        expect(profiles.getServerProfileById('srv_old_identity')?.id).toBe(created.id);
        expect(profiles.getServerProfileLegacyServerIds('srv_new_identity')).toEqual(
            expect.arrayContaining([created.id, 'srv_old_identity']),
        );
    });

    it('preserves non-selected identities as aliases when equivalent URL profiles are deduped', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const now = Date.now();
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'new-profile',
            servers: {
                'old-profile': {
                    id: 'old-profile',
                    name: 'Old',
                    serverUrl: 'https://relay.example.test',
                    serverIdentityId: 'srv_old_identity',
                    createdAt: now - 10,
                    updatedAt: now - 10,
                    lastUsedAt: now - 10,
                },
                'new-profile': {
                    id: 'new-profile',
                    name: 'New',
                    serverUrl: 'https://relay.example.test/',
                    serverIdentityId: 'srv_new_identity',
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: now,
                },
            },
        }));

        const profiles = await importFresh();
        const active = profiles.getActiveServerSnapshot();

        expect(active.serverId).toBe('srv_new_identity');
        expect(profiles.getServerProfileById('srv_old_identity')?.serverIdentityId).toBe('srv_new_identity');
        expect(profiles.getServerProfileLegacyServerIds('srv_new_identity')).toEqual(
            expect.arrayContaining(['old-profile', 'new-profile', 'srv_old_identity']),
        );
    });

    it('keeps host-derived active ids when no server identity is known', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://old-server.example.test', name: 'Old Relay' });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.getActiveServerId()).toBe(created.id);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
    });

    it('ignores unsafe server identity ids from server payloads', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'relay.example.test')).toBeNull();

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
        const profile = profiles.getServerProfileById(created.id);
        expect(profile?.id).toBe(created.id);
        expect(profile).not.toHaveProperty('serverIdentityId');
        expect(profile).not.toHaveProperty('legacyServerIds');
    });

    it('dedupes profiles that learn the same server identity across different hostnames', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const lan = profiles.upsertServerProfile({ serverUrl: 'https://macbook.local:18829', name: 'LAN' });
        const tunnel = profiles.upsertServerProfile({ serverUrl: 'https://public.example.test', name: 'Public' });

        profiles.setServerProfileIdentityForUrl(lan.serverUrl, 'srv_shared_identity');
        profiles.setServerProfileIdentityForUrl(tunnel.serverUrl, 'srv_shared_identity');

        const all = profiles.listServerProfiles().filter((profile) => profile.serverIdentityId === 'srv_shared_identity');
        expect(all).toHaveLength(1);
        expect(profiles.getServerProfileLegacyServerIds('srv_shared_identity')).toEqual(
            expect.arrayContaining([lan.id, tunnel.id]),
        );
        profiles.setActiveServerId(tunnel.id, { scope: 'device' });
        expect(profiles.getActiveServerSnapshot().serverId).toBe('srv_shared_identity');
    });

    it('seeds api.happier.dev on app.happier.dev web origin when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('https://app.happier.dev');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://app.happier.dev')).toBe(false);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('does not seed a same-origin server profile when EXPO_PUBLIC_HAPPY_SERVER_URL is set', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://configured.example.test';
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('https://selfhost.example.test');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://configured.example.test')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://selfhost.example.test')).toBe(false);
    });

    it('derives deterministic filesystem-safe ids from server URLs', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const one = profiles.upsertServerProfile({ serverUrl: 'https://Example.COM:8443/' });
        const two = profiles.upsertServerProfile({ serverUrl: 'https://example.com:8443' });

        expect(one.id).toBe(two.id);
        expect(one.id).toMatch(/^[a-z0-9._-]+$/);
    });

    it('can rename a server profile without changing its id', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = profiles.upsertServerProfile({ serverUrl: 'https://rename.example.test', name: 'Before' });
        profiles.renameServerProfile(created.id, 'After');

        const list = profiles.listServerProfiles();
        const updated = list.find((p) => p.id === created.id);
        expect(updated?.name).toBe('After');
    });

    it('seeds a preconfigured server from EXPO_PUBLIC_HAPPY_SERVER_URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3999';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'http://localhost:3999')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3999');
    });

    it('preserves the stack-env server profile id when rewriting a private IP URL to a loopback hostname on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://172.20.10.4:53288';
        stubWebRuntime('http://happier-dev.localhost:19364');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://happier-dev.localhost:53288')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://happier-dev.localhost:53288');
    });

    it('updates an existing stack-env server profile URL without changing its id when the web loopback hostname changes', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://172.20.10.4:53288';

        stubWebRuntime('http://172.20.10.4:19364');
        const initial = await importFresh();
        expect(initial.listServerProfiles().some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://172.20.10.4:53288')).toBe(true);

        stubWebRuntime('http://happier-dev.localhost:19364');
        const updated = await importFresh();
        const all = updated.listServerProfiles();

        expect(all.filter((p) => p.id.startsWith('172.20.10.4-53288')).length).toBe(1);
        expect(all.some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://happier-dev.localhost:53288')).toBe(true);
        expect(updated.getActiveServerUrl()).toBe('http://happier-dev.localhost:53288');
    });

    it('seeds from EXPO_PUBLIC_HAPPIER_SERVER_URL and prefers it over legacy aliases', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = 'https://canonical.example.test';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'https://canonical.example.test')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://legacy-happy.example.test')).toBe(false);
        expect(all.some((p) => p.serverUrl === 'https://legacy-generic.example.test')).toBe(false);
        expect(profiles.getActiveServerUrl()).toBe('https://canonical.example.test');
    });

    it('uses EXPO_PUBLIC_SERVER_URL as a final alias when canonical and happy aliases are unset', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'https://legacy-generic.example.test')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://legacy-generic.example.test');
    });

    it('seeds multiple preconfigured servers from EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = JSON.stringify([
            { name: 'Local 3013', url: 'http://localhost:3013' },
            { name: 'Cloud Alt', url: 'https://api.happier.dev' },
        ]);

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
    });

    it('treats a remote URL added manually as a normal removable profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const remote = profiles.upsertServerProfile({ serverUrl: 'https://api.happier.dev', name: 'remote-manual' });
        expect(profiles.listServerProfiles().some((p) => p.id === remote.id)).toBe(true);
        expect(() => profiles.removeServerProfile(remote.id)).not.toThrow();
        expect(profiles.listServerProfiles().some((p) => p.id === remote.id)).toBe(false);
    });

    it('emits a server profile generation update when profiles change', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const before = profiles.getServerProfilesGeneration();
        const generations: number[] = [];
        const unsubscribe = profiles.subscribeServerProfiles((generation: number) => {
            generations.push(generation);
        });

        const remote = profiles.upsertServerProfile({ serverUrl: 'https://relay-gen.example.test', name: 'remote-gen' });
        profiles.removeServerProfile(remote.id);
        unsubscribe();

        const after = profiles.getServerProfilesGeneration();
        expect(after).toBeGreaterThan(before);
        expect(generations.length).toBeGreaterThan(0);
        expect(generations[generations.length - 1]!).toBe(after);
    });

    it('does not bump server profiles generation when reading an existing Happier Cloud profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const before = profiles.getServerProfilesGeneration();

        profiles.getOrCreateHappierCloudServerProfile();
        const afterCreate = profiles.getServerProfilesGeneration();

        profiles.getOrCreateHappierCloudServerProfile();
        const afterRead = profiles.getServerProfilesGeneration();

        expect(afterCreate).toBeGreaterThanOrEqual(before);
        expect(afterRead).toBe(afterCreate);
    });

    it('treats a happier-*.localhost web origin as stack context even if EXPO_PUBLIC_HAPPY_SERVER_CONTEXT is unset', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('treats a happier-*.localhost web origin as stack context even if EXPO_PUBLIC_HAPPY_SERVER_CONTEXT is an unknown value', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'dev';
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('does not let an unknown EXPO_PUBLIC_HAPPY_SERVER_CONTEXT disable localhost stack inference', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'custom-env';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const seeded = profiles.listServerProfiles().find((p) => p.serverUrl === 'http://localhost:3013');
        expect(seeded?.source).toBe('stack-env');
    });

    it('does not re-seed removed preconfigured servers after initial load', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = JSON.stringify([
            { name: 'Cloud Embedded', url: 'https://api.happier.dev' },
        ]);

        const profiles = await importFresh();
        const seeded = profiles.listServerProfiles().find((p) => p.serverUrl === 'https://api.happier.dev');
        expect(seeded).toBeTruthy();

        profiles.removeServerProfile(seeded!.id);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);

        expect(profiles.getActiveServerUrl()).toBe('');
        expect(profiles.getResetToDefaultServerId()).toBe('');
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('dedupes localhost and 127.0.0.1 loopback URLs into one profile without rewriting the stored host form', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'local-a' });
        const second = profiles.upsertServerProfile({ serverUrl: 'http://127.0.0.1:3012', name: 'local-b' });

        expect(second.id).toBe(first.id);
        expect(second.name).toBe('local-a');
        expect(second.serverUrl).toBe('http://localhost:3012');
        expect(profiles.listServerProfiles().filter((p) => p.id === first.id)).toHaveLength(1);
    });

    it('dedupes equivalent URLs that differ only by query/hash and stores canonical URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = profiles.upsertServerProfile({
            serverUrl: 'https://admin:secret@example.com:8443/path/?token=abc#frag',
            name: 'Query Hash Server',
        });
        const second = profiles.upsertServerProfile({
            serverUrl: 'https://admin:secret@example.com:8443/path',
            name: 'Canonical Server',
        });

        expect(second.id).toBe(first.id);
        expect(second.serverUrl).toBe('https://example.com:8443/path');
        expect(profiles.listServerProfiles().filter((p) => p.id === first.id)).toHaveLength(1);
    });

    it('reset-to-default targets the stack env server in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });

        const resetId = profiles.getResetToDefaultServerId();
        expect(resetId).toBeTruthy();

        profiles.setActiveServerId(resetId, { scope: 'device' });
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('reset-to-default targets the seeded cloud profile outside stack context when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;

        const profiles = await importFresh();
        const cloud = profiles.listServerProfiles().find((p) => p.serverUrl === 'https://api.happier.dev');
        expect(cloud).toBeTruthy();

        const one = profiles.upsertServerProfile({ serverUrl: 'https://one.example.test', name: 'one' });
        const two = profiles.upsertServerProfile({ serverUrl: 'https://two.example.test', name: 'two' });
        profiles.setActiveServerId(two.id, { scope: 'device' });
        expect(profiles.getResetToDefaultServerId()).toBe(cloud!.id);
    });

    it('seeds the stack env server profile on load in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('does not throw when setting active server id to an unknown value (ignores request)', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });

        expect(() => profiles.setActiveServerId('missing', { scope: 'device' })).not.toThrow();
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3012');
    });
});
