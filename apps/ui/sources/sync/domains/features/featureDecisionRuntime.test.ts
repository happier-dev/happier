import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

installDisconnectedServerSocketBoundary();
// Load the real cold module graph after its transport boundary, during collection.
await loadSyncSingletonForTests();



(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let testProfiles: typeof import('@/sync/domains/server/serverProfiles');
let testConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let testHomes: ReturnType<typeof createHomeGovernanceHarness>;

async function publishTestHomeProfiles(options: { restoreAccount?: boolean } = {}): Promise<void> {
    testProfiles = await import('@/sync/domains/server/serverProfiles');
    testHomes = createHomeGovernanceHarness();
    for (const serverId of ['srv_server-a', 'srv_server-b']) {
        const serverUrl = `https://${serverId}.example.test`;
        await testHomes.addHome({
            name: serverId,
            serverIdentityId: serverId,
            serverUrl,
            accountId: options.restoreAccount ? (serverId === 'srv_server-a' ? 'account-a' : 'account-b') : null,
            active: false,
        });
        // The connection owner needs the Home-published carrier descriptor,
        // beyond the harness's saved Home/Account HTTP responses.
        await testProfiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: serverId,
                canonicalServerUrl: serverUrl,
                revision: 1,
                endpoints: [{ kind: 'https', url: serverUrl }],
            },
            source: 'manual',
            preserveUserLabel: true,
        });
    }
    await testProfiles.setActiveServerId('srv_server-a');
    expect(testProfiles.getActiveServerSnapshot()).toMatchObject({ serverId: 'srv_server-a', serverUrl: 'https://srv_server-a.example.test' });
    if (options.restoreAccount) {
        testConnection = await restoreServerAccountForTest({
            serverUrl: 'https://srv_server-a.example.test',
            serverIdentityId: 'srv_server-a',
            request: testHomes.request,
        });
        expect(testProfiles.getActiveServerSnapshot()).toMatchObject({
            serverId: 'srv_server-a',
            runtimeOrigin: 'https://srv_server-a.example.test',
            carrier: 'https',
        });
    }
}

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

async function activateTestHome(serverId: string): Promise<void> {
    await testProfiles.setActiveServerId(serverId);
    if (testConnection) {
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await switchConnectionToActiveServer();
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

function countFeaturesFetchCalls(fetchMock: { mock: { calls: Array<readonly unknown[]> } }): number {
    return fetchMock.mock.calls.filter((call) => isFeaturesFetchUrl(call[0])).length;
}

describe('featureDecisionRuntime', () => {
    it('resolves the released Automations alias through the Workflows decision in runtime and selected Homes', async () => {
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { resolveRuntimeFeatureDecisionFromSnapshot, resolveMainSelectionFeatureDecision } = await import('./featureDecisionRuntime');
        const settings = { ...settingsDefaults, featureToggles: { automations: false } };
        const features = FeaturesResponseSchema.parse({ features: {
            workflows: { enabled: true }, automations: { enabled: true },
        } });
        const snapshot = { status: 'ready' as const, features };
        expect(resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'automations', settings, snapshot }))
            .toMatchObject({ featureId: 'workflows', state: 'disabled', blockedBy: 'local_policy' });
        expect(resolveMainSelectionFeatureDecision({ featureId: 'automations', settings, snapshot: {
            status: 'ready', serverIds: ['home'], snapshotsByServerId: { home: snapshot },
        } })).toMatchObject({ featureId: 'workflows', state: 'disabled', blockedBy: 'local_policy' });
    });

    afterEach(async () => {
        // Retire mounted retry observers before disconnecting their Account;
        // keep the credential and socket boundaries installed for real teardown.
        standardCleanup();
        try {
            await testConnection?.dispose();
            await testHomes?.reset();
        } finally {
            testConnection = undefined;
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
    });

    it.each(['disabled', 'empty', 'cached'] as const)('does not enqueue an unchanged %s selection before a store render', async (selection) => {
        await publishTestHomeProfiles();
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { storage, useSetting } = await import('@/sync/domains/state/storage');
        const { useServerFeaturesMainSelectionSnapshot } = await import('./featureDecisionRuntime');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ serverId: 'srv_server-a', snapshot: {
            status: 'ready', features: createFeaturesPayload({ voiceEnabled: false }),
        } });
        const serverIds = selection === 'empty' ? [] : ['srv_server-a'];
        const commits = vi.fn();
        let renders = 0;
        function Probe() {
            const snapshot = useServerFeaturesMainSelectionSnapshot(serverIds, { enabled: selection !== 'disabled' });
            useSetting('experiments');
            renders += 1;
            return React.createElement('View', { snapshot });
        }
        const screen = await renderScreen(React.createElement(React.Profiler, { id: selection, onRender: commits }, React.createElement(Probe)));
        expect(screen.findByType('View').props.snapshot.status).toBe('ready');
        const baseline = { commits: commits.mock.calls.length, renders };
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
        });
        expect({ commits: commits.mock.calls.length - baseline.commits, renders: renders - baseline.renders })
            .toEqual({ commits: 1, renders: 1 });
        await screen.unmount();
    });

    it('reprojects a mounted runtime snapshot when the same server cache entry changes', async () => {
        await publishTestHomeProfiles();
        const {
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: 'srv_server-a',
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
                serverId: 'srv_server-a',
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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles();

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
        await publishTestHomeProfiles({ restoreAccount: true });

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            const raw = readFetchUrl(url);
            if (!raw.includes('/v1/features')) {
                return testHomes.request(url, init);
            }
            const voiceEnabled = new URL(raw).hostname === 'srv_server-a.example.test';
            return Response.json(createFeaturesPayload({ voiceEnabled }));
        });
        vi.stubGlobal('fetch', fetchMock);
        setRuntimeFetch(fetchMock);

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

            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({ status: 'ready' }));
            const initialFetchCalls = countFeaturesFetchCalls(fetchMock);
            expect(initialFetchCalls).toBeGreaterThan(0);
            expect(seen.some((entry) => entry?.status === 'ready')).toBe(true);
            const firstReady = seen.find((entry) => entry?.status === 'ready') as any;
            expect(firstReady.features.features.voice.enabled).toBe(true);

            await act(async () => {
                await activateTestHome('srv_server-b');
                await flushHookEffects(6);
            });

            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({
                status: 'ready', features: { features: { voice: { enabled: false } } },
            }));
            expect(countFeaturesFetchCalls(fetchMock)).toBeGreaterThan(initialFetchCalls);
            const last = seen.at(-1) as any;
            expect(last?.status).toBe('ready');
            expect(last.features.features.voice.enabled).toBe(false);
        } finally {
            resetRuntimeFetch();
        }
    });

    it('refreshes the runtime server feature snapshot after the cache TTL expires', async () => {
        await publishTestHomeProfiles({ restoreAccount: true });

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        let fetchCallIndex = 0;
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            const raw = readFetchUrl(url);
            if (!raw.includes('/v1/features')) {
                return testHomes.request(url, init);
            }
            const voiceEnabled = fetchCallIndex === 0;
            fetchCallIndex += 1;
            return Response.json(createFeaturesPayload({ voiceEnabled }));
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

            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({ status: 'ready' }));
            const initialFetchCalls = countFeaturesFetchCalls(fetchMock);
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

            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({
                status: 'ready', features: { features: { voice: { enabled: false } } },
            }));
            expect(countFeaturesFetchCalls(fetchMock)).toBeGreaterThan(initialFetchCalls);
            const last = seen.at(-1) as any;
            expect(last?.status).toBe('ready');
            expect(last.features.features.voice.enabled).toBe(false);

            nowSpy.mockRestore();
        } finally {
            resetRuntimeFetch();
        }
    });

    it('does not refetch explicit serverId snapshots on remount while cache is fresh', async () => {
        await publishTestHomeProfiles({ restoreAccount: true });

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

        await act(async () => {
            await activateTestHome('srv_server-a');
            await flushHookEffects(2);
        });

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();

        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => isFeaturesFetchUrl(url)
            ? Response.json(createFeaturesPayload({ voiceEnabled: true }))
            : testHomes.request(url, init));
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useServerFeaturesSnapshotForServerId } = await import('./featureDecisionRuntime');

        const seen: Array<ReturnType<typeof useServerFeaturesSnapshotForServerId>> = [];
        function Test() {
            const value = useServerFeaturesSnapshotForServerId('srv_server-a');
            React.useEffect(() => { seen.push(value); }, [value]);
            return React.createElement('View');
        }

        let screen = await renderScreen(React.createElement(Test));
        await flushHookEffects(20);
        await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({ status: 'ready' }));
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
        await publishTestHomeProfiles({ restoreAccount: true });

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        let featuresFetchCount = 0;
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            if (!isFeaturesFetchUrl(url)) {
                return testHomes.request(url, init);
            }
            featuresFetchCount += 1;
            if (featuresFetchCount === 1) throw new Error('temporary server restart');
            return Response.json(createFeaturesPayload({ voiceEnabled: true }));
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
            resetServerFeaturesClientForTests();
            const { useServerFeaturesMainSelectionSnapshot } = await import('./featureDecisionRuntime');
            const seen: any[] = [];

            function Test() {
                const value = useServerFeaturesMainSelectionSnapshot(['srv_server-a']);
                React.useEffect(() => {
                    seen.push(value);
                }, [value]);
                return React.createElement('View');
            }

            let screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            await waitForHomeGovernance(() => expect(seen.at(-1)?.snapshotsByServerId?.['srv_server-a']).toMatchObject({ status: 'error', reason: 'network' }));
            expect(countFeaturesFetchCalls(fetchMock)).toBe(1);
            expect(seen.at(-1)?.snapshotsByServerId?.['srv_server-a']).toMatchObject({
                status: 'error',
                reason: 'network',
            });

            now = 5_001;
            await act(async () => {
                screen.tree.unmount();
                screen = await renderScreen(React.createElement(Test));
        await flushHookEffects(10);
            });

            await waitForHomeGovernance(() => expect(seen.at(-1)?.snapshotsByServerId?.['srv_server-a']).toMatchObject({ status: 'ready' }));
            expect(countFeaturesFetchCalls(fetchMock)).toBe(2);
            expect(seen.at(-1)?.snapshotsByServerId?.['srv_server-a']).toMatchObject({
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

    it('shares one retry timer and read across mixed consumers and publishes recovery', async () => {
        await publishTestHomeProfiles({ restoreAccount: true });

        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
        let runRetries: Array<() => void> = [];
        let retryFires = 0;
        const retryTimerId = 42_424 as unknown as ReturnType<typeof setTimeout>;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === 5_000) {
                runRetries.push(() => {
                    retryFires += 1;
                    now += 5_001;
                    if (typeof handler === 'function') handler(...args);
                });
                return retryTimerId;
            }
            return nativeSetTimeout(handler, timeout, ...args);
        });
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        let featuresFetchCount = 0;
        let responseMode: 'recover' | 'error' | 'unsupported' | 'forbidden' = 'recover';
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            if (!isFeaturesFetchUrl(url)) {
                return testHomes.request(url, init);
            }
            featuresFetchCount += 1;
            if (responseMode === 'unsupported') {
                return Response.json(({}), { status: 404 });
            }
            if (responseMode === 'forbidden') return Response.json({}, { status: 403 });
            if (responseMode === 'error' || featuresFetchCount === 1) {
                throw new Error('temporary server restart');
            }
            return Response.json(createFeaturesPayload({ voiceEnabled: true }));
        });
        vi.stubGlobal('fetch', fetchMock as any);
        setRuntimeFetch(fetchMock as any);

        try {
            const {
                primeServerFeaturesSnapshot,
                resetServerFeaturesClientForTests,
            } = await import('@/sync/api/capabilities/serverFeaturesClient');
            const primeReadyPeer = () => primeServerFeaturesSnapshot({
                serverId: 'srv_server-b',
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
                const mainSelection = useServerFeaturesMainSelectionSnapshot(['srv_server-a', 'srv_server-b']);
                const runtime = useServerFeaturesRuntimeSnapshot();
                const explicit = useServerFeaturesSnapshotForServerId('srv_server-a');
                React.useEffect(() => {
                    seen.push({ mainSelection, runtime, explicit });
                }, [explicit, mainSelection, runtime]);
                return React.createElement('View');
            }

            const screen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({
                mainSelection: { snapshotsByServerId: { 'srv_server-a': { status: 'error' } } },
                runtime: { status: 'error' }, explicit: { status: 'error' },
            }));
            expect(countFeaturesFetchCalls(fetchMock)).toBe(1);
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['srv_server-a']).toMatchObject({ status: 'error' });
            expect(seen.at(-1)?.runtime).toMatchObject({ status: 'error' });
            expect(seen.at(-1)?.explicit).toMatchObject({ status: 'error' });
            expect(runRetries).toHaveLength(1);

            await act(async () => {
                const retries = runRetries;
                runRetries = [];
                retries.forEach((retry) => retry());
        await flushHookEffects(10);
            });

            await waitForHomeGovernance(() => expect(seen.at(-1)).toMatchObject({
                mainSelection: { snapshotsByServerId: { 'srv_server-a': { status: 'ready' } } },
                runtime: { status: 'ready' }, explicit: { status: 'ready' },
            }));
            expect(countFeaturesFetchCalls(fetchMock)).toBe(2);
            expect(retryFires).toBe(1);
            expect(runRetries).toHaveLength(0);
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['srv_server-a']).toMatchObject({ status: 'ready' });
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['srv_server-b']).toMatchObject({ status: 'ready' });
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
            expect(runRetries).toHaveLength(1);
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
            expect(seen.at(-1)?.mainSelection?.snapshotsByServerId?.['srv_server-a']).toMatchObject({
                status: 'unsupported',
                reason: 'endpoint_missing',
            });
            expect(runRetries).toHaveLength(0);
            await act(async () => {
                unsupportedScreen.tree.unmount();
        await flushHookEffects(2);
            });

            resetServerFeaturesClientForTests();
            primeReadyPeer();
            responseMode = 'forbidden';
            runRetries = [];
            const forbiddenScreen = await renderScreen(React.createElement(Test));
            await flushHookEffects(10);
            expect(seen.at(-1)).toMatchObject({
                mainSelection: { snapshotsByServerId: { 'srv_server-a': { status: 'error', httpStatus: 403 } } },
                runtime: { status: 'error', httpStatus: 403 }, explicit: { status: 'error', httpStatus: 403 },
            });
            expect(runRetries).toHaveLength(0);
            await forbiddenScreen.unmount();
        } finally {
            nowSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            resetRuntimeFetch();
        }
    });

    it('re-arms one cached retry at its original deadline when demand remounts before expiry', async () => {
        await publishTestHomeProfiles({ restoreAccount: true });
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
        const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
        const retries = new Map<ReturnType<typeof setTimeout>, { dueAt: number; fire: () => void }>();
        let nextTimerId = 92_000;
        let fires = 0;
        const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
            if (timeout === 5_000 || timeout === 4_000) {
                const id = ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
                retries.set(id, { dueAt: now + timeout, fire: () => {
                    retries.delete(id);
                    fires += 1;
                    if (typeof handler === 'function') handler(...args);
                } });
                return id;
            }
            return nativeSetTimeout(handler, timeout, ...args);
        });
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(id => {
            if (retries.delete(id as ReturnType<typeof setTimeout>)) return;
            nativeClearTimeout(id);
        });
        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let reads = 0;
        setRuntimeFetch(async (url, init) => {
            if (!isFeaturesFetchUrl(url)) return testHomes.request(url, init);
            if (++reads === 1) throw new Error('temporary restart');
            return Response.json(createFeaturesPayload({ voiceEnabled: true }));
        });
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { useServerFeaturesSnapshotForServerId } = await import('./featureDecisionRuntime');
        function Probe() {
            return React.createElement('View', { snapshot: useServerFeaturesSnapshotForServerId('srv_server-a') });
        }
        try {
            resetServerFeaturesClientForTests();
            const first = await renderScreen(React.createElement(Probe));
            await flushHookEffects(10);
            expect(first.findByType('View').props.snapshot).toMatchObject({ status: 'error' });
            expect([...retries.values()].map(retry => retry.dueAt)).toEqual([5_000]);
            await first.unmount();
            expect(retries.size).toBe(0);
            now = 1_000;
            const remount = await renderScreen(React.createElement(Probe));
            await flushHookEffects(10);
            expect(reads).toBe(1);
            expect([...retries.values()].map(retry => retry.dueAt)).toEqual([5_000]);
            now = 4_999;
            expect(fires).toBe(0);
            expect(reads).toBe(1);
            now = 5_000;
            await act(async () => {
                [...retries.values()].forEach(retry => retry.fire());
                await flushHookEffects(10);
            });
            expect(fires).toBe(1);
            expect(reads).toBe(2);
            expect(remount.findByType('View').props.snapshot).toMatchObject({ status: 'ready' });
            expect(retries.size).toBe(0);
            await remount.unmount();
        } finally {
            standardCleanup();
            resetServerFeaturesClientForTests();
            resetRuntimeFetch();
            clearSpy.mockRestore();
            timerSpy.mockRestore();
            nowSpy.mockRestore();
        }
    });

    it('discards an already-dequeued runtime retry after the active server changes', async () => {
        await publishTestHomeProfiles({ restoreAccount: true });
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
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            if (isFeaturesFetchUrl(url)) throw new Error('srv_server-a is restarting');
            return testHomes.request(url, init);
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
                serverId: 'srv_server-b',
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
        await activateTestHome('srv_server-b');
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
        await publishTestHomeProfiles({ restoreAccount: true });
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
        const fetchMock = vi.fn<typeof testHomes.request>(async (url, init) => {
            if (isFeaturesFetchUrl(url)) throw new Error('still restarting');
            return testHomes.request(url, init);
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
        await publishTestHomeProfiles();

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
            const snapshot = useServerFeaturesMainSelectionSnapshot(['srv_server-a'], { enabled: false });
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
            serverIds: ['srv_server-a'],
            snapshotsByServerId: {},
        });
        const settledSnapshot = seen.at(-1);
        const settledSeenCount = seen.length;

        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: 'srv_server-a',
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
            deleteServerFeaturesSnapshot({ serverId: 'srv_server-a' });
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
