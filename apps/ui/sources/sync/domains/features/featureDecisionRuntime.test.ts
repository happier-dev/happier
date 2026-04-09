import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_ACTIVE_SERVER = Object.freeze({
    serverId: 'server-a',
    serverUrl: 'https://server-a.example.test',
    generation: 1,
});

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
            remoteHosts: {
                management: { enabled: false },
                secretMaterial: { enabled: false },
            },
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

function readFetchUrl(url: unknown): string {
    if (typeof url === 'string') return url;
    if (typeof URL === 'function' && url instanceof URL) {
        return url.toString();
    }
    if (url && typeof url === 'object') {
        const urlProp = (url as { url?: unknown }).url;
        if (typeof urlProp === 'string' || (urlProp && typeof urlProp === 'object')) {
            const value = String(urlProp ?? '');
            if (value) return value;
        }
        const hrefProp = (url as { href?: unknown }).href;
        if (typeof hrefProp === 'string' || (hrefProp && typeof hrefProp === 'object')) {
            const value = String(hrefProp ?? '');
            if (value) return value;
        }
    }
    try {
        return String(url ?? '');
    } catch {
        return '';
    }
}

function isFeaturesFetchUrl(url: unknown): boolean {
    const raw = readFetchUrl(url);
    return raw.includes('/v1/features');
}

function isHealthFetchUrl(url: unknown): boolean {
    const raw = readFetchUrl(url);
    return raw.endsWith('/health');
}

function countFeaturesFetchCalls(fetchMock: { mock: { calls: Array<readonly unknown[]> } }): number {
    return fetchMock.mock.calls.filter((call) => isFeaturesFetchUrl(call[0])).length;
}

describe('featureDecisionRuntime', () => {
    afterEach(() => {
        standardCleanup();
        activeServerListeners.listeners.clear();
        activeServerRef.current = { ...DEFAULT_ACTIVE_SERVER };
        vi.unstubAllGlobals();
    });

	    it('ignores non-public build policy env vars in UI bundles', async () => {
	        vi.resetModules();

        const previousDenyPublic = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        const previousDenyPrivate = process.env.HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = 'voice';

	        try {
	            const { getStorage } = await import('@/sync/domains/state/storage');
	            getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });
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
	            getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });
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

    it('fails closed when remoteHosts.management is missing or disabled in the server snapshot', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'remoteHosts.management',
            settings,
            snapshot: { status: 'ready', features: createFeaturesPayload({ voiceEnabled: false }) },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).toBe('disabled');
        expect(decision?.blockedBy).toBe('server');
    });

    it('enables remoteHosts.management when server snapshot gate is enabled', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'remoteHosts.management',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        remoteHosts: {
                            management: { enabled: true },
                            secretMaterial: { enabled: false },
                        },
                    },
                    capabilities: {},
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).toBe('enabled');
    });

    it('disables remoteHosts.secretMaterial when remoteHosts.management is disabled (dependency)', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'remoteHosts.secretMaterial',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        remoteHosts: {
                            management: { enabled: false },
                            secretMaterial: { enabled: true },
                        },
                    },
                    capabilities: {},
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).toBe('disabled');
        expect(decision?.blockedBy).toBe('dependency');
    });

    it('refetches the server feature snapshot when active server changes', async () => {
        vi.resetModules();

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn(async (url: any) => {
            const raw = readFetchUrl(url);
            if (!raw.includes('/v1/features')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                } as Response;
            }
            const voiceEnabled = activeServerRef.current.serverId === 'server-a';
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
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

            await renderScreen(React.createElement(Test));
            await flushHookEffects(6);

            const initialFetchCalls = fetchMock.mock.calls.length;
            expect(initialFetchCalls).toBeGreaterThan(0);
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

            expect(fetchMock.mock.calls.length).toBeGreaterThan(initialFetchCalls);
            const last = seen.at(-1) as any;
            expect(last?.status).toBe('ready');
            expect(last.features.features.voice.enabled).toBe(false);
        } finally {
            resetRuntimeFetch();
        }
    });

    it('refreshes the runtime server feature snapshot after the cache TTL expires', async () => {
        vi.resetModules();

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        let fetchCallIndex = 0;
        const fetchMock = vi.fn(async (url: any) => {
            const raw = readFetchUrl(url);
            if (!raw.includes('/v1/features')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                } as Response;
            }
            const voiceEnabled = fetchCallIndex === 0;
            fetchCallIndex += 1;
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
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

            let screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(6);

            const initialFetchCalls = fetchMock.mock.calls.length;
            expect(initialFetchCalls).toBeGreaterThan(0);
            expect(seen.some((entry) => entry?.status === 'ready')).toBe(true);
            const firstReady = seen.find((entry) => entry?.status === 'ready') as any;
            expect(firstReady.features.features.voice.enabled).toBe(true);

            // Advance beyond TTL_READY_MS (10 minutes) so the cached snapshot should be treated as stale.
            now = 10 * 60 * 1000 + 1;

            await act(async () => {
                screen.tree.unmount();
                screen = await renderScreen(React.createElement(Test));
                await flushHookEffects(6);
            });

            expect(fetchMock.mock.calls.length).toBeGreaterThan(initialFetchCalls);
            const last = seen.at(-1) as any;
            expect(last?.status).toBe('ready');
            expect(last.features.features.voice.enabled).toBe(false);

            nowSpy.mockRestore();
        } finally {
            resetRuntimeFetch();
        }
    });

    it('does not refetch explicit serverId snapshots on remount while cache is fresh', async () => {
        vi.resetModules();

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        // Clean up any leaked listeners from prior tests (defensive); otherwise emitting an active
        // server change can trigger state updates outside of this test's `act()` scopes.
        activeServerListeners.listeners.clear();

        await act(async () => {
            emitActiveServerChanged({
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
                generation: 1,
            });
            await flushHookEffects(2);
        });

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();

        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => createFeaturesPayload({ voiceEnabled: true }),
        }) as Response);
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useServerFeaturesSnapshotForServerId } = await import('./featureDecisionRuntime');

        function Test() {
            useServerFeaturesSnapshotForServerId('server-a');
            return React.createElement('View');
        }

        let screen = await renderScreen(React.createElement(Test));
        await flushHookEffects(20);
        expect(countFeaturesFetchCalls(fetchMock)).toBe(1);

        // Remount within TTL_READY_MS.
        now = 1;
        await act(async () => {
            screen.tree.unmount();
            screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(20);
        });

        expect(countFeaturesFetchCalls(fetchMock)).toBe(1);

        await act(async () => {
            screen.tree.unmount();
            await flushHookEffects(4);
        });

        nowSpy.mockRestore();
        resetRuntimeFetch();
    });
});
