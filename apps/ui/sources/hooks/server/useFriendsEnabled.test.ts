import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildServerFeaturesResponse, stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);


const homes = createHomeGovernanceHarness();
beforeEach(async () => {
    await homes.reset();
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    getStorage().setState({ settings: { ...settingsDefaults }, settingsScope: null });
    // Device credential reads are the OS boundary; selection and usable-Home policy stay real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => {
        const token = homes.findByServerUrl(serverUrl)?.token;
        return token ? { token } : null;
    });
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(() => ({
        version: 1, groups: [], activeTargetKind: null, activeTargetId: null,
    }), { scope: 'device' });
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('useFriendsEnabled', () => {
    it('returns false when the server reports friends are disabled', async () => {
        await stubServerFeaturesFetch({ friendsEnabled: false });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('fails closed when the request fails', async () => {
        await stubServerFeaturesFetchFailure();
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
        await stubServerFeaturesFetch({ friendsEnabled: true });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });

    it('returns false when local experiment gate is disabled', async () => {
        await stubServerFeaturesFetch({ friendsEnabled: true });
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

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const primaryId = await homes.addHome({ serverUrl: 'http://primary.example.test', name: 'Primary', accountId: 'account-primary' });
        const legacyId = await homes.addHome({ serverUrl: 'http://legacy.example.test', name: 'Legacy', accountId: 'account-legacy', active: false });
        await homes.selectHomes([primaryId, legacyId]);

        const okPayload = buildServerFeaturesResponse({ friendsEnabled: true });
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes('legacy.example.test') && url.endsWith('/v1/features')) {
                    return new Response(null, { status: 404 });
                }
                return Response.json(okPayload);
            }),
        );

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        await getServerFeaturesSnapshot({ serverId: primaryId, force: true });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const { useEffectiveServerSelection } = await import('./useEffectiveServerSelection');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const hook = await renderHook(() => ({ enabled: useFriendsEnabled(), selection: useEffectiveServerSelection() }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().selection.serverIds).toEqual([primaryId, legacyId]);
            expect(hook.getCurrent().enabled).toBe(true);
        });
    });
});
