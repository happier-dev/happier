import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64 } from '@/encryption/base64';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/track', () => ({ trackLogout: vi.fn(), initializeTracking: vi.fn(), tracking: null }));

let dispose: (() => Promise<void>) | undefined;
let restoreStorage: (() => void) | undefined;
afterEach(async () => { await standardCleanup(); await dispose?.(); restoreStorage?.(); vi.unstubAllGlobals(); });

it.each(['targeted', 'all'])('the post-logout notice stops Home A sockets and keys in Home B window W after %s forget', async scope => {
    vi.resetModules();
    const h = await createConcurrentCacheNetworkHarness('desktop-credential-realms');
    dispose = () => h.dispose();
    const { AuthProvider } = await import('./AuthContext');
    const { resolveScopedAccountEncryption } = await import('@/sync/encryption/scopedAccountEncryption');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    await h.reset();
    const secret = new Uint8Array(32).fill(23);
    const credentials = { token: h.homeA.token, secret: encodeBase64(secret, 'base64url') };
    await h.network.addHome(h.homeA.serverUrl, h.homeA.accountId, { credentials, encryptionMode: 'e2ee' });
    h.setResponder(async input => {
        const url = new URL(String(input));
        if (url.origin === h.homeA.serverUrl && url.pathname === '/v1/account/encryption/currentness') {
            return Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret }));
        }
        return null;
    });
    await h.profiles.setActiveServerId(h.homeB.id, { scope: 'device' });
    publishAppliedActiveServerSnapshot(h.profiles.getActiveServerSnapshot(), false);

    const native = (globalThis as typeof globalThis & { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const listeners = new Map<number, { event: string; handler: (event: { payload: unknown }) => void }>();
    let nextId = 0;
    const internals = { metadata: { currentWindow: { label: 'destination_w' } },
        transformCallback: (handler: (event: { payload: unknown }) => void) => { const id = ++nextId; callbacks.set(id, handler); return id; },
        invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen') {
                const handler = callbacks.get(Number(args?.handler));
                if (!handler) throw new Error('Missing native event callback');
                const id = ++nextId; listeners.set(id, { event: String(args?.event), handler }); return id;
            }
            if (command === 'plugin:event|unlisten') { listeners.delete(Number(args?.eventId)); return; }
            if (command === 'desktop_app_windows_teardown') return;
            if (command === 'desktop_app_windows_auth_changed') {
                // Native IPC is the boundary: deliver its routing-only notice to app windows.
                vi.stubGlobal('sessionStorage', windowStorage);
                for (const { event, handler } of listeners.values()) if (event === 'desktopAppWindow://account-teardown') {
                    handler({ payload: { mutations: args?.mutations ?? [], sourceWindowLabel: 'main' } });
                }
                return;
            }
            return await native.invoke(command, args);
        } };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('window', { location: { href: 'tauri://localhost/desktop/app-window' }, __TAURI_INTERNALS__: internals,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) } });
    vi.stubGlobal('document', {});
    restoreStorage = installLocalStorageMock().restore;
    const { seedPersistedHomeProfilesForTests } = await import('@/dev/testkit/fixtures/persistedHomeProfiles');
    const profiles = h.profiles.listServerProfiles();
    await seedPersistedHomeProfilesForTests({ profiles, activeServerId: h.homeB.id, browserStorage: window.localStorage });
    await h.select();
    const tabValues = new Map<string, string>();
    const windowStorage = { getItem: (key: string) => tabValues.get(key) ?? null,
        setItem: (key: string, value: string) => { tabValues.set(key, value); }, removeItem: (key: string) => { tabValues.delete(key); } };
    vi.stubGlobal('sessionStorage', windowStorage);
    await h.profiles.setActiveServerId(h.homeB.id, { scope: 'tab' });
    if (scope === 'all') {
        expect(await h.TokenStorage.removeCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id })).toBe(true);
    }
    await renderScreen(<AuthProvider initialCredentials={scope === 'all' ? null : { token: h.homeB.token }}>{null}</AuthProvider>);
    await vi.waitFor(() => expect([...listeners.values()].some(({ event }) => event === 'desktopAppWindow://account-teardown')).toBe(true));
    h.startConcurrentSessionCacheSync();
    await h.ready(h.homeA);
    const socket = h.socket(h.homeA);
    const encryption = await resolveScopedAccountEncryption({ serverId: h.homeA.id, serverUrl: h.homeA.serverUrl, credentials });
    if (!encryption) throw new Error('Home A E2EE material was not admitted');
    const generation = encryption.getCurrentEncryptionGenerationScope();
    expect({ connected: socket.socket.connected, keysCurrent: encryption.isCurrentEncryptionGenerationScope(generation) })
        .toEqual({ connected: true, keysCurrent: true });

    // A second module graph is main's credential realm; its local event cannot reach W.
    vi.resetModules();
    const main = await import('@/auth/storage/tokenStorage');
    const mainProfiles = await import('@/sync/domains/server/serverProfiles');
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    await mainProfiles.setActiveServerId(h.homeA.id, { scope: 'device' });
    expect(mainProfiles.getActiveServerSnapshot().serverId).toBe(h.homeA.id);
    await act(async () => {
        expect(scope === 'all' ? await main.TokenStorage.removeCredentials()
            : await main.TokenStorage.removeCredentialsForServerUrl(h.homeA.serverUrl, { serverId: h.homeA.id })).toBe(true);
    });
    expect({ connected: socket.socket.connected, keysCurrent: encryption.isCurrentEncryptionGenerationScope(generation) })
        .toEqual({ connected: false, keysCurrent: false });
    expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]).toBeUndefined();
    expect(h.profiles.getActiveServerSnapshot().serverId).toBe(h.homeB.id);
    if (scope === 'targeted') {
        expect(await h.TokenStorage.getCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id })).toEqual({ token: h.homeB.token });
    }
});
