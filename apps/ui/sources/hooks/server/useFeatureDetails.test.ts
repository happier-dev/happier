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
        stubServerFeaturesFetch({ automationsEnabled: true, automationsExistingSessionTarget: true });

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
                select: (features) => features.features.automations.existingSessionTarget === true,
            }),
        );

        expect(seen.at(-1)).toBe(true);
    });

    it('returns fallback when feature probing fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

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
    });

    it('uses spawn scope server id when provided', async () => {
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
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
                    return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsExistingSessionTarget: false }) };
                }
                if (href.includes('b.example')) {
                    return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsExistingSessionTarget: true }) };
                }
                return { ok: true, status: 200, json: async () => buildServerFeaturesResponse({ automationsExistingSessionTarget: false }) };
            }) as any,
        );

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            (useFeatureDetails as any)({
                featureId: 'automations',
                fallback: false,
                select: (features: any) => features.features.automations.existingSessionTarget === true,
                scope: { scopeKind: 'spawn', serverId: serverB.id },
            }),
        );

        expect(seen.at(-1)).toBe(true);
    });
});
