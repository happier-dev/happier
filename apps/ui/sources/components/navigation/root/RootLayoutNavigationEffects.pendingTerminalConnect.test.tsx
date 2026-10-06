import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { parsePendingTerminalConnectPreAuthEnvelope } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replaceSpy = vi.fn();
let isAuthenticated = false;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/',
        segments: ['(app)'],
        router: { replace: replaceSpy },
    }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', async () => (
    await import('@/sync/domains/pending/pendingTerminalConnect.web')
));

vi.mock('@/hooks/ui/useWebInitialRouteReconcile', () => ({ useWebInitialRouteReconcile: () => {} }));
vi.mock('@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation', () => ({
    consumeLegacySessionDeepLinkFromWebLocation: () => false,
}));
vi.mock('@/activity/notifications/runtime/useNotificationResponseRouting', () => ({
    useNotificationResponseRouting: () => {},
}));
vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    invokeDesktopHost: vi.fn(),
    isDesktopHost: () => false,
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
const runtimeFetchSpy = vi.hoisted(() => vi.fn(async () => new Response('', { status: 503 })));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: runtimeFetchSpy,
}));

function createStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => { values.delete(key); },
        setItem: (key, value) => { values.set(key, value); },
    };
}

// Compile the real owner before any per-case behavior deadline.
await import('./RootLayoutNavigationEffects');

afterEach(() => {
    standardCleanup();
    isAuthenticated = false;
    replaceSpy.mockClear();
    runtimeFetchSpy.mockClear();
    vi.unstubAllGlobals();
});

it('resumes a real pre-auth capture when the authenticated account scope hydrates', async () => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { storage } = await import('@/sync/domains/state/storage');
    const { setPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect.web');
    const { RootLayoutNavigationEffects } = await import('./RootLayoutNavigationEffects');

    const server = await upsertAndActivateServer({
        serverUrl: 'https://stack.example.test',
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    setPendingTerminalConnect({
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverUrl: 'https://stack.example.test',
        serverIdentityId: 'srv_stack',
        pairing: {
            secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_900_000_060_000,
        },
        homeConnectionDescriptor: {
            v: 1,
            homeServerIdentityId: 'srv_stack',
            canonicalServerUrl: 'https://stack.example.test',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://stack.example.test' }],
        },
    });

    const rendered = await renderScreen(<RootLayoutNavigationEffects />);
    isAuthenticated = true;
    await act(async () => rendered.tree.update(<RootLayoutNavigationEffects />));
    expect(replaceSpy).not.toHaveBeenCalled();

    const scope = createServerAccountScope(server.id, 'account-a');
    expect(scope).not.toBeNull();
    await act(async () => storage.getState().activateProfileScope(scope!));

    expect(replaceSpy).toHaveBeenCalledWith(expect.stringContaining('/terminal/connect#v4='));
});

it('retains a pending terminal link for an unfocused unsaved Home without probing or routing', async () => {
    runtimeFetchSpy.mockClear();
    vi.resetModules();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { storage } = await import('@/sync/domains/state/storage');
    const pending = await import('@/sync/domains/pending/pendingTerminalConnect.web');
    const { RootLayoutNavigationEffects } = await import('./RootLayoutNavigationEffects');

    const active = await upsertAndActivateServer({
        serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device',
    });
    const captured = {
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverUrl: 'https://unreachable.example.test',
        serverIdentityId: 'srv_new_home',
    };
    pending.setPendingTerminalConnect(captured);
    const scope = createServerAccountScope(active.id, 'account-a');
    expect(scope).not.toBeNull();
    await act(async () => storage.getState().activateProfileScope(scope!));
    isAuthenticated = true;
    replaceSpy.mockClear();
    const rendered = await renderScreen(<RootLayoutNavigationEffects />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(profiles.getActiveServerId()).toBe(active.id);
    expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === captured.serverUrl)).toBe(false);
    expect(pending.getPendingTerminalConnect()).toBeNull();
    const envelope = parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(sessionStorage.getItem(
        scopedStorageId('pending-terminal-connect-pre-auth:v1', readStorageScopeFromEnv()),
    )!));
    expect(envelope?.record).toMatchObject(captured);
    await rendered.unmount();
});

it('retains a pending terminal service address under focused-Home custody without selecting or routing', async () => {
    vi.resetModules();
    const address = 'https://accounts.example.test';
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { storage } = await import('@/sync/domains/state/storage');
    const pending = await import('@/sync/domains/pending/pendingTerminalConnect.web');
    const { RootLayoutNavigationEffects } = await import('./RootLayoutNavigationEffects');
    const active = await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const captured = {
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', serverUrl: address, serverIdentityId: 'srv_accounts_entry',
        pairing: {
            secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_900_000_060_000,
        },
    };
    pending.setPendingTerminalConnect(captured);
    const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
    await act(async () => storage.getState().activateProfileScope(createServerAccountScope(active.id, 'account-a')!));
    isAuthenticated = true;
    const screen = await renderScreen(<RootLayoutNavigationEffects />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
    expect(profiles.getActiveServerId()).toBe(active.id);
    expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === address)).toBe(false);
    expect(pending.getPendingTerminalConnect()).toBeNull();
    const envelope = parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(sessionStorage.getItem(
        scopedStorageId('pending-terminal-connect-pre-auth:v1', readStorageScopeFromEnv()),
    )!));
    expect(envelope?.record).toMatchObject(captured);
    await screen.unmount();
});
