import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();

// Load the real owner graph during collection, before the behavior deadline starts.
await import('./useAddHomeFlow');

describe('Add a Home focus at entry', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.resetModules();
    });

    it('focuses the first usable Home, but leaves an existing usable Home focused', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `add_home_focus_${Date.now()}_${Math.random()}`;
        const storage = installLocalStorageMock();
        const locks = installWebLockManagerMock();
        const tabValues = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => tabValues.get(key) ?? null,
            setItem: (key: string, value: string) => { tabValues.set(key, value); },
            removeItem: (key: string) => { tabValues.delete(key); },
        });
        vi.stubGlobal('window', { location: { origin: 'https://client.example.test' } });
        vi.stubGlobal('document', { getElementById: () => null });
        try {
            const [{ renderHook }, renderer, profiles, projection, { TokenStorage }, { useAddHomeFlow }] = await Promise.all([
                import('@/dev/testkit'),
                import('react-test-renderer'),
                import('@/sync/domains/server/serverProfiles'),
                import('@/sync/domains/scope/usableHomeServerIds'),
                import('@/auth/storage/tokenStorage'),
                import('./useAddHomeFlow'),
            ]);
            profiles.resetServerProfilesRuntimeForTests();
            const existing = await profiles.upsertServerProfile({ serverUrl: 'https://existing-home.example.test', name: 'Existing' });
            await profiles.setActiveServerId(existing.id, { scope: 'device' });
            await profiles.setActiveServerId(existing.id, { scope: 'tab' });
            expect(profiles.getTabActiveServerId()).toBe(existing.id);
            await vi.waitFor(() => expect(projection.readUsableHomeServerIds()).toEqual([]));

            const input = {
                initialPath: 'direct' as const,
                serviceStatus: 'ready' as const,
                serviceHostsHome: false,
                canSetUpServerHome: false,
            };
            const first = await renderHook(() => useAddHomeFlow(input));
            let firstResult: unknown;
            await renderer.act(async () => { firstResult = await first.getCurrent().onConnected(existing); });
            expect(firstResult).toMatchObject({ kind: 'focused', profile: existing });
            expect(first.getCurrent().completion).toMatchObject({ kind: 'focused', profile: existing });
            expect(profiles.getTabActiveServerId()).toBe(existing.id);
            await first.unmount();

            const accountToken = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2EifQ.sig';
            await TokenStorage.setCredentialsForServerUrl(existing.serverUrl, { serverId: existing.id }, { token: accountToken });
            await vi.waitFor(() => expect(projection.readUsableHomeServerIds()).toEqual([existing.id]));
            const added = await profiles.upsertServerProfile({ serverUrl: 'https://added-home.example.test', name: 'Added' });
            const next = await renderHook(() => useAddHomeFlow(input));
            let nextResult: unknown;
            await renderer.act(async () => { nextResult = await next.getCurrent().onConnected(added); });
            expect(nextResult).toMatchObject({ kind: 'connected', profile: added });
            expect(next.getCurrent().completion).toMatchObject({ kind: 'connected', profile: added });
            expect(profiles.getActiveServerId()).toBe(existing.id);
            await TokenStorage.setCredentialsForServerUrl(added.serverUrl, { serverId: added.id }, { token: accountToken });
            await vi.waitFor(() => expect(projection.readUsableHomeServerIds()).toEqual(expect.arrayContaining([existing.id, added.id])));
            await renderer.act(async () => { await next.getCurrent().homeConnected(added); });
            expect(next.getCurrent().pane.pane).not.toBe('home_sign_in');
            expect(next.getCurrent().completion).toMatchObject({ kind: 'connected', profile: added });
            const selection = await import('@/sync/domains/server/selection/homeViewSelectionState');
            await selection.updateEffectiveHomeViewState((current) => ({
                ...current, activeTargetKind: 'server', activeTargetId: existing.id,
            }), { scope: 'tab' });
            await renderer.act(async () => { await next.getCurrent().showAllHomes(); });
            expect(selection.loadEffectiveHomeViewState()).toMatchObject({ activeTargetKind: 'group', activeTargetId: '@all-homes' });
            const { getEffectiveServerSelectionFromRawSettings } = await import('@/sync/domains/server/selection/serverSelectionResolution');
            expect(getEffectiveServerSelectionFromRawSettings({
                activeServerId: existing.id,
                availableServerIds: [existing.id, added.id],
                settings: {
                    serverSelectionGroups: [],
                    serverSelectionActiveTargetKind: selection.loadEffectiveHomeViewState()?.activeTargetKind,
                    serverSelectionActiveTargetId: selection.loadEffectiveHomeViewState()?.activeTargetId,
                },
                usableServerIds: projection.readUsableHomeServerIds(),
            }).serverIds).toEqual([existing.id, added.id]);
            await next.unmount();
        } finally {
            locks.restore();
            storage.restore();
        }
    });
});
