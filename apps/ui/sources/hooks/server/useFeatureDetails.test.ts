import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFeatureDetails', () => {
    it('returns selected server details when features are ready', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true });

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
        vi.resetModules();
        stubServerFeaturesFetchFailure();

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
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { getStorage } = await import('@/sync/domains/state/storage');

        resetServerFeaturesClientForTests();

        const serverA = upsertServerProfile({ serverUrl: 'https://a.example', name: 'A', source: 'manual' });
        const serverB = upsertServerProfile({ serverUrl: 'https://b.example', name: 'B', source: 'manual' });
        setActiveServerId(serverA.id, { scope: 'device' });

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: any) => {
                const href = String(url ?? '');
                if (href.includes('a.example')) {
                    return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsEnabled: false }) };
                }
                if (href.includes('b.example')) {
                    return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsEnabled: true }) };
                }
                return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsEnabled: false }) };
            }) as any,
        );

        // Seed spawn cache to avoid relying on fireAndForget probe timing.
        await getServerFeaturesSnapshot({ serverId: serverB.id, force: true });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            (useFeatureDetails as any)({
                featureId: 'automations',
                fallback: false,
                select: (features: any) => Boolean(features?.features?.automations?.enabled),
                scope: { scopeKind: 'spawn', serverId: serverB.id },
            }),
        );

        expect(seen.at(-1)).toBe(true);
    }, 30_000);
});
