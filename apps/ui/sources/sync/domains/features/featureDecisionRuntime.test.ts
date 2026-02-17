import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerRef = vi.hoisted(() => ({
    current: {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    },
}));

const activeServerListeners = vi.hoisted(() => ({
    listeners: new Set<(snapshot: unknown) => void>(),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerRef.current,
    subscribeActiveServer: (listener: (snapshot: unknown) => void) => {
        activeServerListeners.listeners.add(listener);
        return () => activeServerListeners.listeners.delete(listener);
    },
}));

function createFeaturesPayload(params: { voiceEnabled: boolean }) {
    return FeaturesResponseSchema.parse({
        features: {
            voice: { enabled: params.voiceEnabled },
        },
        capabilities: {
            voice: {
                configured: params.voiceEnabled,
                provider: params.voiceEnabled ? 'elevenlabs' : null,
            },
        },
    });
}

function emitActiveServerChanged(next: { serverId: string; serverUrl: string; generation: number }) {
    activeServerRef.current = next;
    for (const listener of activeServerListeners.listeners) {
        listener(next);
    }
}

describe('featureDecisionRuntime', () => {
    it('ignores non-public build policy env vars in UI bundles', async () => {
        vi.resetModules();

        const previousDenyPublic = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        const previousDenyPrivate = process.env.HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = 'voice';

        try {
            const { getStorage } = await import('@/sync/domains/state/storage');
            getStorage().getState().applySettingsLocal({ experiments: true });
            const settings = getStorage().getState().settings;
            const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

            // When server features are still loading, a server-required feature should remain unresolved
            // unless it is blocked by a *public* build policy.
            const decision = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: 'voice',
                settings,
                snapshot: { status: 'loading' },
                scope: { scopeKind: 'runtime' },
            });

            expect(decision).toBeNull();
        } finally {
            if (previousDenyPublic === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDenyPublic;
            if (previousDenyPrivate === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            else process.env.HAPPIER_BUILD_FEATURES_DENY = previousDenyPrivate;
        }
    });

    it('applies build policy without waiting for server probes in runtime scope', async () => {
        vi.resetModules();

        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'voice';

        try {
            const { getStorage } = await import('@/sync/domains/state/storage');
            const settings = getStorage().getState().settings;
            const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

            const decision = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: 'voice',
                settings,
                snapshot: { status: 'loading' },
                scope: { scopeKind: 'runtime' },
            });

            expect(decision).not.toBeNull();
            expect(decision?.state).toBe('disabled');
            expect(decision?.blockedBy).toBe('build_policy');
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('refetches the server feature snapshot when active server changes', async () => {
        vi.resetModules();

        const fetchMock = vi.fn(async (url: any) => {
            const raw = String(url ?? '');
            const voiceEnabled = raw.includes('server-a.example.test');
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useServerFeaturesRuntimeSnapshot } = await import('./featureDecisionRuntime');

        const seen: any[] = [];

        function Test() {
            const value = useServerFeaturesRuntimeSnapshot();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(fetchMock.mock.calls.some((call) => String(call[0] ?? '').includes('server-a.example.test'))).toBe(true);
        expect(seen.some((entry) => entry?.status === 'ready')).toBe(true);
        const firstReady = seen.find((entry) => entry?.status === 'ready') as any;
        expect(firstReady.features.features.voice.enabled).toBe(true);

        await act(async () => {
            emitActiveServerChanged({
                serverId: 'server-b',
                serverUrl: 'https://server-b.example.test',
                generation: 2,
            });
            await flushHookEffects(6);
        });

        expect(fetchMock.mock.calls.some((call) => String(call[0] ?? '').includes('server-b.example.test'))).toBe(true);
        const last = seen.at(-1) as any;
        expect(last?.status).toBe('ready');
        expect(last.features.features.voice.enabled).toBe(false);
    });

    it('refreshes the runtime server feature snapshot after the cache TTL expires', async () => {
        vi.resetModules();

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        let fetchCallIndex = 0;
        const fetchMock = vi.fn(async () => {
            const voiceEnabled = fetchCallIndex === 0;
            fetchCallIndex += 1;
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useServerFeaturesRuntimeSnapshot } = await import('./featureDecisionRuntime');

        const seen: any[] = [];

        function Test() {
            const value = useServerFeaturesRuntimeSnapshot();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return React.createElement('View');
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(seen.some((entry) => entry?.status === 'ready')).toBe(true);
        const firstReady = seen.find((entry) => entry?.status === 'ready') as any;
        expect(firstReady.features.features.voice.enabled).toBe(true);

        // Advance beyond TTL_READY_MS (10 minutes) so the cached snapshot should be treated as stale.
        now = 10 * 60 * 1000 + 1;

        await act(async () => {
            tree?.unmount();
            tree = renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const last = seen.at(-1) as any;
        expect(last?.status).toBe('ready');
        expect(last.features.features.voice.enabled).toBe(false);

        nowSpy.mockRestore();
    });
});
