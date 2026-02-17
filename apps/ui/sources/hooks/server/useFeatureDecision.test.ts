import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFeatureDecision', () => {
    it('fails closed for main selection when servers disagree (mixed scope support)', async () => {
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

        const serverA = upsertServerProfile({ serverUrl: 'https://a.example', name: 'A', source: 'manual' });
        const serverB = upsertServerProfile({ serverUrl: 'https://b.example', name: 'B', source: 'manual' });
        setActiveServerId(serverA.id, { scope: 'device' });

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
            serverSelectionGroups: [
                {
                    id: 'grp-main',
                    name: 'Main',
                    serverIds: [serverA.id, serverB.id],
                    presentation: 'grouped',
                },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-main',
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: any) => {
                const href = String(url ?? '');
                if (href.includes('a.example')) {
                    return { ok: true, json: async () => buildServerFeaturesResponse({ automationsEnabled: true }) };
                }
                if (href.includes('b.example')) {
                    return { ok: true, json: async () => buildServerFeaturesResponse({ automationsEnabled: false }) };
                }
                return { ok: true, json: async () => buildServerFeaturesResponse({ automationsEnabled: true }) };
            }) as any,
        );

        await getServerFeaturesSnapshot({ serverId: serverA.id, force: true });
        await getServerFeaturesSnapshot({ serverId: serverB.id, force: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('automations'));

        expect(seen.at(-1)?.state).toBe('unsupported');
        expect(seen.at(-1)?.blockedBy).toBe('scope');
        expect(seen.at(-1)?.blockerCode).toBe('mixed_scope_support');
        expect(seen.at(-1)?.scope.scopeKind).toBe('main_selection');
    }, 30_000);

    it('returns enabled decision when the feature is available', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true });

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ experiments: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('enabled');
        expect(seen.at(-1)?.blockedBy).toBeNull();
    }, 30_000);

    it('returns unsupported when the features endpoint is missing', async () => {
        vi.resetModules();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => ({}),
            })) as any,
        );

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ experiments: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unsupported');
        expect(seen.at(-1)?.blockerCode).toBe('endpoint_missing');
    }, 30_000);

    it('returns unknown when probing features fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({ experiments: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unknown');
        expect(seen.at(-1)?.blockerCode).toBe('probe_failed');
    }, 30_000);
});
