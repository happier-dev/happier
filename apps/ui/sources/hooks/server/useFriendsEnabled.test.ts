import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServerFeaturesResponse, stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFriendsEnabled', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('returns false when the server reports friends are disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: false });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when local and server policy are enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });

    it('returns false when local experiment gate is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: false,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when the active server supports friends even if a selected group contains an unsupported server', async () => {
        vi.resetModules();

        // Isolate persisted server profile state so this test can't interfere with other suites.
        const scope = `friendsEnabled_group_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await import('@/sync/domains/server/serverProfiles');

        const primary = profiles.upsertServerProfile({ serverUrl: 'http://primary.example.test', name: 'Primary' });
        const legacy = profiles.upsertServerProfile({ serverUrl: 'http://legacy.example.test', name: 'Legacy' });
        profiles.setActiveServerId(primary.id, { scope: 'device' });

        const okPayload = buildServerFeaturesResponse({ friendsEnabled: true });
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: any) => {
                const url = typeof input === 'string' ? input : String(input?.url ?? '');
                if (url.includes('legacy.example.test') && url.endsWith('/v1/features')) {
                    return { ok: false, status: 404 } as any;
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => okPayload,
                } as any;
            }) as any,
        );

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
            serverSelectionGroups: [{ id: 'g1', name: 'Group', serverIds: [primary.id, legacy.id], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'g1',
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });
});
