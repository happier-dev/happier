import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerFeaturesResponse } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

beforeEach(() => {
    resetServerFeaturesClientForTests();
    getStorage().setState(initialStorageState, true);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useFeatureDecision - voice.agent dependency probing', () => {
    it('probes server snapshot for voice.agent when voice dependency is server-represented', async () => {
        // voice.agent is client-represented but depends on voice (server-represented)
        // The hook should probe the server snapshot to resolve the dependency chain
        const fetchMock = vi.fn<
            (input: unknown, init?: unknown) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
        >(async () => ({
            ok: true,
            status: 200,
            json: async () => buildServerFeaturesResponse({ voiceEnabled: true }),
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true },
        });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice.agent'));

        // The hook should have fetched the server snapshot to resolve the voice dependency
        expect(fetchMock).toHaveBeenCalled();
        const toUrlString = (input: unknown): string => {
            if (typeof input === 'string') return input;
            if (input instanceof URL) return input.toString();
            if (input && typeof (input as Request).url === 'string') return (input as Request).url;
            return String(input);
        };

        const serverFeaturesCall = fetchMock.mock.calls.find(([input]) => toUrlString(input).includes('/v1/features'));
        expect(serverFeaturesCall).toBeTruthy();

        // The final decision should be enabled since voice is enabled on the server
        expect(seen.at(-1)?.state).toBe('enabled');
        expect(seen.at(-1)?.blockedBy).toBeNull();
    }, 30_000);

    it('fails when voice dependency is disabled on server', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => buildServerFeaturesResponse({ voiceEnabled: false }),
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true },
        });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice.agent'));

        // Should have probed the server
        expect(fetchMock).toHaveBeenCalled();

        // Should be blocked by the voice dependency being disabled
        expect(seen.at(-1)?.state).toBe('disabled');
        expect(seen.at(-1)?.blockedBy).toBe('server');
        // When a dependency is disabled on the server, the blocker code is 'feature_disabled' for the dependency
        expect(seen.at(-1)?.blockerCode).toBe('feature_disabled');
    }, 30_000);
});
