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

    it('reprojects a mounted runtime snapshot when the same server cache entry changes', async () => {
        vi.resetModules();
        const {
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: 'server-a',
            snapshot: {
                status: 'ready',
                features: createFeaturesPayload({ voiceEnabled: false }),
            },
        });
        const { useServerFeaturesRuntimeSnapshot } = await import('./featureDecisionRuntime');
        const seen: Array<ReturnType<typeof useServerFeaturesRuntimeSnapshot>> = [];

        function Test() {
            const snapshot = useServerFeaturesRuntimeSnapshot();
            React.useEffect(() => {
                seen.push(snapshot);
            }, [snapshot]);
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test));
        expect(seen.at(-1)).toMatchObject({
            status: 'ready',
            features: { features: { voice: { enabled: false } } },
        });

        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: 'server-a',
                snapshot: {
                    status: 'ready',
                    features: createFeaturesPayload({ voiceEnabled: true }),
                },
            });
            await flushHookEffects(2);
        });

        expect(seen.at(-1)).toMatchObject({
            status: 'ready',
            features: { features: { voice: { enabled: true } } },
        });
        await screen.unmount();
    });

    it('keeps app.ui.onboardingTour disabled even when the legacy rollout env enables it', async () => {
        const env = process.env as Record<string, string | undefined>;
        const enableKey = 'EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED';
        const previousEnable = env[enableKey];
        const previousAllow = env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        const previousDeny = env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

        delete env[enableKey];
        env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW =
            'app.ui.onboardingTour,app.ui.sessionGettingStartedGuidance';
        delete env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        vi.resetModules();

        try {
            const { getStorage } = await import('@/sync/domains/state/storage');
            const settings = getStorage().getState().settings;
            const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

            const disabled = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: 'app.ui.onboardingTour',
                settings,
                snapshot: { status: 'loading' },
                scope: { scopeKind: 'runtime' },
            });

            expect(disabled).toMatchObject({
                state: 'disabled',
                blockedBy: 'local_policy',
                blockerCode: 'flag_disabled',
            });

            env[enableKey] = 'not-a-boolean';
            const malformed = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: 'app.ui.onboardingTour',
                settings,
                snapshot: { status: 'loading' },
                scope: { scopeKind: 'runtime' },
            });

            expect(malformed).toMatchObject({
                state: 'disabled',
                blockedBy: 'local_policy',
                blockerCode: 'flag_disabled',
            });

            env[enableKey] = '1';
            const stillDisabled = resolveRuntimeFeatureDecisionFromSnapshot({
                featureId: 'app.ui.onboardingTour',
                settings,
                snapshot: { status: 'loading' },
                scope: { scopeKind: 'runtime' },
            });

            expect(stillDisabled).toMatchObject({
                state: 'disabled',
                blockedBy: 'local_policy',
                blockerCode: 'flag_disabled',
            });
        } finally {
            if (previousEnable === undefined) delete env[enableKey];
            else env[enableKey] = previousEnable;
            if (previousAllow === undefined) delete env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
            else env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = previousAllow;
            if (previousDeny === undefined) delete env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
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

    it('reports localServices disabled when the server snapshot disables it', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'localServices',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: false } },
                    capabilities: {},
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).not.toBe('enabled');
    });

    it('reports browser.context disabled when the server snapshot disables it', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'browser.context',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        browser: {
                            enabled: true,
                            viewTargets: { enabled: true },
                            internal: { enabled: true },
                            context: { enabled: false },
                        },
                    },
                    capabilities: {},
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).not.toBe('enabled');
    });

    it('reports plugins.ui disabled when the server snapshot disables the plugin platform', async () => {
        vi.resetModules();

        const { getStorage } = await import('@/sync/domains/state/storage');
        const settings = getStorage().getState().settings;
        const { resolveRuntimeFeatureDecisionFromSnapshot } = await import('./featureDecisionRuntime');

        const decision = resolveRuntimeFeatureDecisionFromSnapshot({
            featureId: 'plugins.ui',
            settings,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { plugins: { enabled: false, ui: { enabled: false } } },
                    capabilities: {},
                }),
            },
            scope: { scopeKind: 'runtime' },
        });

        expect(decision).not.toBeNull();
        expect(decision?.state).not.toBe('enabled');
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

    it('refetches a transient main-selection feature error after its cache TTL expires and the consumer remounts', async () => {
        vi.resetModules();

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        let featuresFetchCount = 0;
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn(async (url: any) => {
            if (!isFeaturesFetchUrl(url)) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                } as Response;
            }
            featuresFetchCount += 1;
            if (featuresFetchCount === 1) throw new Error('temporary server restart');
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled: true }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
            resetServerFeaturesClientForTests();
            const { useServerFeaturesMainSelectionSnapshot } = await import('./featureDecisionRuntime');
            const seen: any[] = [];

            function Test() {
                const value = useServerFeaturesMainSelectionSnapshot(['server-a']);
                React.useEffect(() => {
                    seen.push(value);
                }, [value]);
                return React.createElement('View');
            }

            let screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(countFeaturesFetchCalls(fetchMock)).toBe(1);
            expect(seen.at(-1)?.snapshotsByServerId?.['server-a']).toMatchObject({
                status: 'error',
                reason: 'network',
            });

            now = 5_001;
            await act(async () => {
                screen.tree.unmount();
                screen = await renderScreen(React.createElement(Test));
                await flushHookEffects(10);
            });

            expect(countFeaturesFetchCalls(fetchMock)).toBe(2);
            expect(seen.at(-1)?.snapshotsByServerId?.['server-a']).toMatchObject({
                status: 'ready',
            });

            await act(async () => {
                screen.tree.unmount();
                await flushHookEffects(2);
            });
        } finally {
            nowSpy.mockRestore();
            resetRuntimeFetch();
        }
    });

    it('recovers a still-mounted main-selection feature consumer after the transient-error backoff', async () => {
        vi.resetModules();

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
        let runRetries: Array<() => void> = [];
        const retryTimerId = 42_424 as unknown as ReturnType<typeof setTimeout>;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === 5_000) {
                runRetries.push(() => {
                    now += 5_001;
                    if (typeof handler === 'function') handler(...args);
                });
                return retryTimerId;
            }
            return nativeSetTimeout(handler, timeout, ...args);
        });
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        let featuresFetchCount = 0;
        let responseMode: 'recover' | 'error' | 'unsupported' = 'recover';
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn(async (url: any) => {
            if (!isFeaturesFetchUrl(url)) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true }),
                } as Response;
            }
            featuresFetchCount += 1;
            if (responseMode === 'unsupported') {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({}),
                } as Response;
            }
            if (responseMode === 'error' || featuresFetchCount === 1) {
                throw new Error('temporary server restart');
            }
            return {
                ok: true,
                status: 200,
                json: async () => createFeaturesPayload({ voiceEnabled: true }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const {
                primeServerFeaturesSnapshot,
                resetServerFeaturesClientForTests,
            } = await import('@/sync/api/capabilities/serverFeaturesClient');
            const primeReadyPeer = () => primeServerFeaturesSnapshot({
                serverId: 'server-b',
                snapshot: {
                    status: 'ready',
                    features: createFeaturesPayload({ voiceEnabled: false }),
                },
            });
            resetServerFeaturesClientForTests();
            primeReadyPeer();
            const {
                useServerFeaturesMainSelectionSnapshot,
                useServerFeaturesRuntimeSnapshot,
                useServerFeaturesSnapshotForServerId,
            } = await import('./featureDecisionRuntime');
            const seen: any[] = [];

            function Test() {
                const mainSelection = useServerFeaturesMainSelectionSnapshot(['server-a', 'server-b']);
                const runtime = useServerFeaturesRuntimeSnapshot();
                const explicit = useServerFeaturesSnapshotForServerId('server-a');
                React.useEffect(() => {
                    seen.push({ mainSelection, runtime, explicit });
                }, [explicit, mainSelection, runtime]);
                return React.createElement('View');
            }

            const screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(countFeaturesFetchCalls(fetchMock)).toBe(1);
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['server-a']).toMatchObject({ status: 'error' });
            expect(seen.at(-1)?.runtime).toMatchObject({ status: 'error' });
            expect(seen.at(-1)?.explicit).toMatchObject({ status: 'error' });
            expect(runRetries).toHaveLength(3);

            await act(async () => {
                const retries = runRetries;
                runRetries = [];
                retries.forEach((retry) => retry());
                await flushHookEffects(10);
            });

            expect(countFeaturesFetchCalls(fetchMock)).toBe(2);
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['server-a']).toMatchObject({ status: 'ready' });
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['server-b']).toMatchObject({ status: 'ready' });
            expect(seen.at(-1)?.runtime).toMatchObject({ status: 'ready' });
            expect(seen.at(-1)?.explicit).toMatchObject({ status: 'ready' });

            await act(async () => {
                screen.tree.unmount();
                await flushHookEffects(2);
            });

            resetServerFeaturesClientForTests();
            primeReadyPeer();
            responseMode = 'error';
            runRetries = [];
            const cancelledScreen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(runRetries).toHaveLength(3);
            const cancelledRetries = runRetries;
            runRetries = [];
            const fetchesBeforeUnmount = countFeaturesFetchCalls(fetchMock);
            await act(async () => {
                cancelledScreen.tree.unmount();
                await flushHookEffects(2);
            });
            expect(clearTimeoutSpy).toHaveBeenCalledWith(retryTimerId);
            await act(async () => {
                cancelledRetries.forEach((retry) => retry());
                await flushHookEffects(4);
            });
            expect(countFeaturesFetchCalls(fetchMock)).toBe(fetchesBeforeUnmount);

            resetServerFeaturesClientForTests();
            primeReadyPeer();
            responseMode = 'unsupported';
            runRetries = [];
            const unsupportedScreen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['server-a']).toMatchObject({
                status: 'unsupported',
                reason: 'endpoint_missing',
            });
            expect(runRetries).toHaveLength(0);
            await act(async () => {
                unsupportedScreen.tree.unmount();
                await flushHookEffects(2);
            });
        } finally {
            nowSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            resetRuntimeFetch();
        }
    });

    it('discards an already-dequeued runtime retry after the active server changes', async () => {
        vi.resetModules();
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
        const retryHandlers: Array<() => void> = [];
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === 5_000) {
                retryHandlers.push(() => {
                    if (typeof handler === 'function') handler(...args);
                });
                return 91_001 as unknown as ReturnType<typeof setTimeout>;
            }
            return nativeSetTimeout(handler, timeout, ...args);
        });
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn(async (url: unknown) => {
            if (isFeaturesFetchUrl(url)) throw new Error('server-a is restarting');
            return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const {
                primeServerFeaturesSnapshot,
                resetServerFeaturesClientForTests,
            } = await import('@/sync/api/capabilities/serverFeaturesClient');
            resetServerFeaturesClientForTests();
            primeServerFeaturesSnapshot({
                serverId: 'server-b',
                snapshot: {
                    status: 'ready',
                    features: createFeaturesPayload({ voiceEnabled: false }),
                },
            });
            const { useServerFeaturesRuntimeSnapshot } = await import('./featureDecisionRuntime');
            const seen: any[] = [];
            function Test() {
                const snapshot = useServerFeaturesRuntimeSnapshot();
                React.useEffect(() => {
                    seen.push(snapshot);
                }, [snapshot]);
                return React.createElement('View');
            }

            const screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(retryHandlers).toHaveLength(1);
            const staleRetry = retryHandlers[0];

            await act(async () => {
                emitActiveServerChanged({
                    serverId: 'server-b',
                    serverUrl: 'https://server-b.example.test',
                    generation: 2,
                });
                await flushHookEffects(6);
            });
            expect(seen.at(-1)).toMatchObject({
                status: 'ready',
                features: { features: { voice: { enabled: false } } },
            });

            now = 5_001;
            await act(async () => {
                staleRetry?.();
                await flushHookEffects(10);
            });
            expect(seen.at(-1)).toMatchObject({
                status: 'ready',
                features: { features: { voice: { enabled: false } } },
            });
            await screen.unmount();
        } finally {
            nowSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            resetRuntimeFetch();
        }
    });

    it('schedules a successor retry when a mounted runtime retry also fails', async () => {
        vi.resetModules();
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
        let retryHandlers: Array<() => void> = [];
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === 5_000) {
                retryHandlers.push(() => {
                    if (typeof handler === 'function') handler(...args);
                });
                return 91_002 as unknown as ReturnType<typeof setTimeout>;
            }
            return nativeSetTimeout(handler, timeout, ...args);
        });
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn(async (url: unknown) => {
            if (isFeaturesFetchUrl(url)) throw new Error('still restarting');
            return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
            resetServerFeaturesClientForTests();
            const { useServerFeaturesRuntimeSnapshot } = await import('./featureDecisionRuntime');
            const screen = await renderScreen(React.createElement(function Test() {
                useServerFeaturesRuntimeSnapshot();
                return React.createElement('View');
            }));
            await flushHookEffects(10);
            expect(retryHandlers).toHaveLength(1);
            const firstRetry = retryHandlers[0];
            retryHandlers = [];

            now = 5_001;
            await act(async () => {
                firstRetry?.();
                await flushHookEffects(10);
            });
            expect(countFeaturesFetchCalls(fetchMock)).toBe(2);
            expect(retryHandlers).toHaveLength(1);
            await screen.unmount();
        } finally {
            nowSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            resetRuntimeFetch();
        }
    });

    it('keeps a disabled main-selection snapshot empty and stable across cache notifications', async () => {
        vi.resetModules();

        const {
            deleteServerFeaturesSnapshot,
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const { useServerFeaturesMainSelectionSnapshot } = await import('./featureDecisionRuntime');

        let renders = 0;
        const seen: Array<ReturnType<typeof useServerFeaturesMainSelectionSnapshot>> = [];
        function Test() {
            renders += 1;
            const snapshot = useServerFeaturesMainSelectionSnapshot(['server-a'], { enabled: false });
            React.useEffect(() => {
                seen.push(snapshot);
            }, [snapshot]);
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test));
        await flushHookEffects(6);

        expect(renders).toBeLessThanOrEqual(2);
        expect(seen.at(-1)).toEqual({
            status: 'ready',
            serverIds: ['server-a'],
            snapshotsByServerId: {},
        });
        const settledSnapshot = seen.at(-1);
        const settledSeenCount = seen.length;

        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: 'server-a',
                snapshot: {
                    status: 'ready',
                    features: createFeaturesPayload({ voiceEnabled: true }),
                },
            });
            await flushHookEffects(2);
        });
        expect(seen).toHaveLength(settledSeenCount);
        expect(seen.at(-1)).toBe(settledSnapshot);

        await act(async () => {
            deleteServerFeaturesSnapshot({ serverId: 'server-a' });
            await flushHookEffects(2);
        });
        expect(seen).toHaveLength(settledSeenCount);
        expect(seen.at(-1)).toBe(settledSnapshot);

        await act(async () => {
            resetServerFeaturesClientForTests();
            await flushHookEffects(2);
        });
        expect(seen).toHaveLength(settledSeenCount);
        expect(seen.at(-1)).toBe(settledSnapshot);

        await act(async () => {
            screen.tree.unmount();
            await flushHookEffects(2);
        });
    });
});
