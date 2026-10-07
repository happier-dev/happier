import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
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

describe('useFeatureDetails', () => {
    it('returns selected server details when features are ready', async () => {
        await stubServerFeaturesFetch({ automationsEnabled: true });

        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        // Seed the cache so the hook can resolve synchronously (avoids timing flake).
        await getServerFeaturesSnapshot({ force: true });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            useFeatureDetails({
                featureId: 'automations',
                fallback: false,
                select: (features) => Boolean((features as any)?.features?.automations?.enabled),
            }),
        );

        expect(seen.at(-1)).toBe(true);
    }, 30_000);

    it('returns fallback when feature probing fails', async () => {
        await stubServerFeaturesFetchFailure();

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            useFeatureDetails({
                featureId: 'automations',
                fallback: false,
                select: () => true,
            }),
        );

        expect(seen.at(-1)).toBe(false);
    }, 30_000);

    it('uses spawn scope server id when provided', async () => {

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getStorage } = await import('@/sync/domains/state/storage');

        resetServerFeaturesClientForTests();

        const serverAId = await homes.addHome({ serverUrl: 'https://a.example', name: 'A' });
        const serverBId = await homes.addHome({ serverUrl: 'https://b.example', name: 'B', active: false });


        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: RequestInfo | URL) => {
                const href = url instanceof Request ? url.url : String(url);
                if (href.includes('a.example')) {
                    return Response.json(buildServerFeaturesResponse({ automationsEnabled: false }));
                }
                if (href.includes('b.example')) {
                    return Response.json(buildServerFeaturesResponse({ automationsEnabled: true }));
                }
                return Response.json(buildServerFeaturesResponse({ automationsEnabled: false }));
            }),
        );

        // Seed spawn cache to avoid relying on fireAndForget probe timing.
        await getServerFeaturesSnapshot({ serverId: serverBId, force: true });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            useFeatureDetails({
                featureId: 'automations',
                fallback: false,
                select: (features) => features.features.automations.enabled,
                scope: { scopeKind: 'spawn', serverId: serverBId },
            }),
        );

        expect(seen.at(-1)).toBe(true);
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe(serverAId);
    }, 30_000);

    it('does not rerender feature details for unrelated account settings', async () => {
        await stubServerFeaturesFetch({ automationsEnabled: true });

        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
            analyticsOptOut: false,
        });

        await getServerFeaturesSnapshot({ force: true });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useFeatureDetails({
                featureId: 'automations',
                fallback: false,
                select: (features) => Boolean(features.features.automations?.enabled),
            });
        });

        expect(hook.getCurrent()).toBe(true);
        const rendersAfterMount = renderCount;

        await act(async () => {
            getStorage().getState().applySettingsLocal({ analyticsOptOut: true });
        });

        expect(renderCount).toBe(rendersAfterMount);

        await act(async () => {
            getStorage().getState().applySettingsLocal({ featureToggles: { automations: false } });
        });

        expect(renderCount).toBeGreaterThan(rendersAfterMount);
        expect(hook.getCurrent()).toBe(false);

        await hook.unmount();
    }, 30_000);
});
