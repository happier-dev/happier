import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const getCachedServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const subscribeServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn());
const getActiveServerHomeCarrierMock = vi.hoisted(() => vi.fn());
const subscribeActiveServerMock = vi.hoisted(() => vi.fn());
const getAuthProviderMock = vi.hoisted(() => vi.fn());
const getServerRetentionPolicyMock = vi.hoisted(() => vi.fn());
const fetchHomeAuthEntryMock = vi.hoisted(() => vi.fn());
const getServerProfileByIdMock = vi.hoisted(() => vi.fn());

// Some shared store modules read the active runtime while the test graph is
// being collected, before `beforeEach` installs the per-case snapshot.
getActiveServerSnapshotMock.mockReturnValue({
    serverId: 'server-example',
    serverUrl: 'http://api.example.test',
    generation: 1,
});

vi.mock('@/auth/entry/authEntryClient', () => ({
    fetchHomeAuthEntry: fetchHomeAuthEntryMock,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: getCachedServerFeaturesSnapshotMock,
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
    subscribeServerFeaturesSnapshot: subscribeServerFeaturesSnapshotMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotMock() ?? {
        serverId: 'server-example',
        serverUrl: 'http://api.example.test',
        generation: 1,
    },
    getActiveServerHomeCarrier: getActiveServerHomeCarrierMock,
    subscribeActiveServer: subscribeActiveServerMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getServerProfileById: getServerProfileByIdMock,
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: getAuthProviderMock,
}));

vi.mock('@/sync/api/capabilities/serverRetentionPolicyClient', () => ({
    getServerRetentionPolicy: getServerRetentionPolicyMock,
}));

const textMock = vi.hoisted(() => {
    const translate = (key: string, params?: Record<string, unknown>) => {
        if (key === 'welcome.signUpWithProvider' && typeof params?.provider === 'string') {
            return `Sign up with ${params.provider}`;
        }
        if (key === 'welcome.signInWithCertificate') return 'Sign in with certificate';
        if (key === 'welcome.createAccount') return 'Create account';
        if (key === 'status.unknown') return 'Unknown';
        return key;
    };
    return {
        t: translate,
        tLoose: translate,
        getPreferredLanguage: () => 'en',
        hasTranslation: () => false,
    };
});

vi.mock('@/text', () => textMock);

describe('useAuthEntryOptions', () => {
    type TestActiveServerSnapshot = Readonly<{
        serverId: string;
        serverUrl: string;
        generation: number;
        isSelectionExplicit?: boolean;
    }>;
    let activeServerListener: ((snapshot: TestActiveServerSnapshot) => void) | null = null;
    let serverFeaturesSnapshotListener: (() => void) | null = null;
    let currentActiveServerSnapshot: TestActiveServerSnapshot;

    beforeEach(() => {
        getServerFeaturesSnapshotMock.mockReset();
        getCachedServerFeaturesSnapshotMock.mockReset();
        subscribeServerFeaturesSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReset();
        getActiveServerHomeCarrierMock.mockReset();
        getActiveServerHomeCarrierMock.mockReturnValue(null);
        subscribeActiveServerMock.mockReset();
        getAuthProviderMock.mockReset();
        getServerRetentionPolicyMock.mockReset();
        getServerRetentionPolicyMock.mockResolvedValue({ status: 'failed' });
        fetchHomeAuthEntryMock.mockReset();
        getServerProfileByIdMock.mockReset();
        getServerProfileByIdMock.mockReturnValue(null);
        fetchHomeAuthEntryMock.mockResolvedValue({ kind: 'unsupported' });
        currentActiveServerSnapshot = {
            serverId: 'server-example',
            serverUrl: 'http://api.example.test',
            generation: 1,
        };
        getActiveServerSnapshotMock.mockImplementation(() => currentActiveServerSnapshot);
        activeServerListener = null;
        serverFeaturesSnapshotListener = null;
        getCachedServerFeaturesSnapshotMock.mockReturnValue(null);
        subscribeServerFeaturesSnapshotMock.mockImplementation((listener: () => void) => {
            serverFeaturesSnapshotListener = listener;
            return () => {
                if (serverFeaturesSnapshotListener === listener) {
                    serverFeaturesSnapshotListener = null;
                }
            };
        });
        subscribeActiveServerMock.mockImplementation((listener: (snapshot: TestActiveServerSnapshot) => void) => {
            activeServerListener = listener;
            return () => {
                if (activeServerListener === listener) {
                    activeServerListener = null;
                }
            };
        });
        getAuthProviderMock.mockImplementation((id: string) => (
            id === 'github' ? { id, displayName: 'GitHub' } : null
        ));
    });

    it('uses current auth-entry presentation for a dynamic provider absent from static features', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    serverIdentity: { serverIdentityId: 'srv_current' },
                    auth: { methods: [], keyChallenge: { v2: true } },
                    oauth: { providers: {} },
                },
            },
        });
        fetchHomeAuthEntryMock.mockResolvedValue({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate',
                    methodId: 'acme',
                    action: 'login',
                    mode: 'keyless',
                    origin: 'home',
                    presentation: { displayName: 'Acme Workforce' },
                }],
                autoRedirect: null,
            },
        });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().serverAvailability).toBe('ready');
        expect(hook.getCurrent().authenticationActions).toEqual([expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'acme', mode: 'keyless' },
            method: expect.objectContaining({ presentation: { displayName: 'Acme Workforce' } }),
        })]);
        expect(hook.getCurrent().keyChallengeV2Available).toBe(true);
    });

    it('renders the active Home cached feature catalog on first paint while live probes are pending', async () => {
        const pendingFeatures = createDeferred<never>();
        const pendingAuthEntry = createDeferred<never>();
        getCachedServerFeaturesSnapshotMock.mockReturnValue({
            status: 'ready',
            features: {
                capabilities: {
                    auth: {
                        methods: [{
                            id: 'key_challenge',
                            actions: [{ id: 'provision', enabled: true, mode: 'keyed' }],
                        }],
                    },
                },
            },
        });
        getServerFeaturesSnapshotMock.mockReturnValue(pendingFeatures.promise);
        fetchHomeAuthEntryMock.mockReturnValue(pendingAuthEntry.promise);

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());

        expect(getCachedServerFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-example' });
        expect(hook.getCurrent()).toMatchObject({
            serverAvailability: 'ready',
            showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })],
        });
    });

    it('falls back to the active Home cached catalog when live feature refresh fails', async () => {
        getCachedServerFeaturesSnapshotMock.mockReturnValue({
            status: 'ready',
            features: {
                capabilities: {
                    auth: {
                        methods: [{
                            id: 'key_challenge',
                            actions: [{ id: 'provision', enabled: true, mode: 'keyed' }],
                        }],
                    },
                },
            },
        });
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            serverAvailability: 'ready',
            showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })],
            authEntryUnavailable: true,
        });
    });

    it('keeps valid Home actions visible while a forced live probe is pending', async () => {
        const readyFeatures = {
            status: 'ready' as const,
            features: {
                capabilities: {
                    auth: {
                        methods: [{
                            id: 'key_challenge',
                            actions: [{ id: 'provision', enabled: true, mode: 'keyed' as const }],
                        }],
                    },
                },
            },
        };
        getServerFeaturesSnapshotMock.mockResolvedValueOnce(readyFeatures);

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true });

        const pendingFeatures = createDeferred<never>();
        const pendingAuthEntry = createDeferred<never>();
        getServerFeaturesSnapshotMock.mockReturnValueOnce(pendingFeatures.promise);
        fetchHomeAuthEntryMock.mockReturnValueOnce(pendingAuthEntry.promise);

        await act(async () => {
            hook.getCurrent().retryServerCheck();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toMatchObject({
            serverAvailability: 'ready',
            showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })],
        });
    });

    it('derives ready-state auth options from server features', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    oauth: { providers: { github: { configured: true } } },
                    auth: {
                        methods: [
                            {
                                id: 'key_challenge',
                                actions: [
                                    { id: 'login', enabled: true, mode: 'keyed' },
                                    { id: 'provision', enabled: true, mode: 'keyed' },
                                ],
                            },
                            {
                                id: 'mtls',
                                actions: [{ id: 'login', enabled: true, mode: 'keyless' }],
                            },
                            {
                                id: 'github',
                                actions: [{ id: 'provision', enabled: true, mode: 'keyed' }],
                            },
                        ],
                        signup: { methods: [{ id: 'anonymous', enabled: true }, { id: 'github', enabled: true }] },
                        login: { methods: [{ id: 'key_challenge', enabled: true }, { id: 'mtls', enabled: true }], requiredProviders: [] },
                        ui: { autoRedirect: { enabled: false, providerId: null } },
                    },
                },
            },
        });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        const options = hook.getCurrent();
        expect(options.serverAvailability).toBe('ready');
        expect(options.serverUrlForCopy).toBe('http://api.example.test');
        expect(options.showAuthActions).toBe(true);
        expect(options.authenticationActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: { kind: 'generated_key' } }),
            expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } }),
            expect.objectContaining({ execution: { kind: 'mtls' } }),
        ]));
    });

    it('says it could not check the Home\'s data retention, with a retry, instead of saying nothing', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: { capabilities: { auth: { methods: [], signup: { methods: [] }, login: { methods: [], requiredProviders: [] }, ui: { autoRedirect: { enabled: false, providerId: null } } } } },
        });
        getServerRetentionPolicyMock.mockResolvedValue({ status: 'failed' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        // Sign-in never waits on retention: the Home stays usable while the disclosure is unreadable.
        expect(hook.getCurrent().serverAvailability).toBe('ready');
        const unreadable = hook.getCurrent().retentionDisclosure;
        expect(unreadable).toMatchObject({ kind: 'unreadable' });

        getServerRetentionPolicyMock.mockResolvedValue({
            status: 'ready',
            policy: { enabled: true, completeness: 'complete', domains: [{ id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } }] },
        });
        const { act } = await import('react-test-renderer');
        await act(async () => { (unreadable as { retry: () => void }).retry(); });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(getServerRetentionPolicyMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
        expect(hook.getCurrent().retentionDisclosure).toMatchObject({ kind: 'summary', summary: expect.any(String) });
    });

    it('projects the active Home carrier as the exact authentication transport', async () => {
        const homeCarrier = {
            endpointId: 'home-carrier-a',
            readObservedPath: vi.fn(),
            request: vi.fn(),
            createWebSocket: vi.fn(),
        };
        getActiveServerHomeCarrierMock.mockReturnValue(homeCarrier);
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'legacy' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().homeTransport).toEqual({ homeCarrier });
    });

    it('distinguishes a seeded fallback Home from an explicitly requested Home', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'legacy' });
        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().homeTarget).toEqual({ kind: 'saved_profile', profileRef: 'server-example' });
        expect(hook.getCurrent().requestedHomeTarget).toBeUndefined();

        await act(async () => {
            currentActiveServerSnapshot = { ...currentActiveServerSnapshot, isSelectionExplicit: true, generation: 2 };
            activeServerListener?.(currentActiveServerSnapshot);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(hook.getCurrent().requestedHomeTarget).toEqual({ kind: 'saved_profile', profileRef: 'server-example' });
    });

    it('clears target A policy and identity as soon as target B observation starts', async () => {
        let resolveTargetB: ((value: unknown) => void) | null = null;
        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce({
                status: 'ready',
                features: {
                    signInService: { v: 1, mode: 'external', endpoint: 'https://accounts-a.example.test' },
                    capabilities: {
                        serverIdentity: { serverIdentityId: 'srv_a' },
                        auth: { methods: [] },
                    },
                },
            })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveTargetB = resolve; }));
        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(hook.getCurrent().observedHomeServerIdentityId).toBe('srv_a');
        expect(hook.getCurrent().signInServicePolicy).toBeTruthy();

        await act(async () => {
            currentActiveServerSnapshot = { serverId: 'server-b', serverUrl: 'https://home-b.example.test', generation: 2 };
            activeServerListener?.(currentActiveServerSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'loading', showAuthActions: false });
        expect(hook.getCurrent().observedHomeServerIdentityId).toBeUndefined();
        expect(hook.getCurrent().signInServicePolicy).toBeUndefined();

        await act(async () => resolveTargetB?.({ status: 'unsupported', reason: 'invalid_payload' }));
    });

    it('removes stale provisioning while retaining login after a forced policy refresh', async () => {
        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce({
                status: 'ready',
                features: {
                    capabilities: {
                        auth: {
                            methods: [
                                {
                                    id: 'key_challenge',
                                    actions: [
                                        { id: 'login', enabled: true, mode: 'keyed' },
                                        { id: 'provision', enabled: true, mode: 'keyed' },
                                    ],
                                },
                            ],
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                status: 'ready',
                features: {
                    capabilities: {
                        auth: {
                            methods: [
                                {
                                    id: 'key_challenge',
                                    actions: [
                                        { id: 'login', enabled: true, mode: 'keyed' },
                                        { id: 'provision', enabled: false, mode: 'keyed' },
                                    ],
                                },
                            ],
                        },
                    },
                },
            });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().authenticationActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: { kind: 'generated_key' } }),
            expect.objectContaining({ execution: { kind: 'key_entry' } }),
        ]));

        await act(async () => {
            hook.getCurrent().retryServerCheck();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
        expect(getServerFeaturesSnapshotMock.mock.calls[1]?.[0]?.force).toBe(true);
        expect(hook.getCurrent().authenticationActions).toEqual([expect.objectContaining({ execution: { kind: 'key_entry' } })]);
    });

    it('marks invalid server payloads as incompatible and hides auth actions', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'invalid_payload' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        const options = hook.getCurrent();
        expect(options.serverAvailability).toBe('incompatible');
        expect(options.showAuthActions).toBe(false);
        expect(options.retryServerCheck).toEqual(expect.any(Function));
    });

    it('re-checks auth options when the active server changes', async () => {
        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce({
                status: 'ready',
                features: {
                    capabilities: {
                        auth: {
                            methods: [
                                {
                                    id: 'key_challenge',
                                    actions: [
                                        { id: 'login', enabled: true, mode: 'keyed' },
                                        { id: 'provision', enabled: true, mode: 'keyed' },
                                    ],
                                },
                            ],
                            signup: { methods: [] },
                            login: { methods: [], requiredProviders: [] },
                            ui: { autoRedirect: { enabled: false, providerId: null } },
                        },
                    },
                },
            })
            .mockResolvedValueOnce({ status: 'unsupported', reason: 'invalid_payload' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().serverAvailability).toBe('ready');
        expect(hook.getCurrent().serverUrlForCopy).toBe('http://api.example.test');
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            currentActiveServerSnapshot = {
                serverId: 'server-other',
                serverUrl: 'http://api.other.test',
                generation: 2,
            };
            activeServerListener?.(currentActiveServerSnapshot);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const options = hook.getCurrent();
        expect(options.serverUrlForCopy).toBe('http://api.other.test');
        expect(options.serverAvailability).toBe('incompatible');
        expect(options.showAuthActions).toBe(false);
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
    });

    it('does not restart a Home check for a generation-only publication', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            hook.getCurrent().retryServerCheck();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().serverAvailability).toBe('unavailable');
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);

        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: { capabilities: { auth: { methods: [] } } },
        });
        await act(async () => {
            currentActiveServerSnapshot = {
                ...currentActiveServerSnapshot,
                generation: currentActiveServerSnapshot.generation + 1,
            };
            activeServerListener?.(currentActiveServerSnapshot);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().serverAvailability).toBe('unavailable');
    });

    it('does not schedule an automatic retry and reconciles only when the canonical feature cache reports recovery', async () => {
        vi.useFakeTimers();
        try {
            const readySnapshot = {
                status: 'ready' as const,
                features: {
                    capabilities: {
                        auth: {
                            methods: [
                                {
                                    id: 'key_challenge',
                                    actions: [
                                        { id: 'login', enabled: true, mode: 'keyed' },
                                        { id: 'provision', enabled: true, mode: 'keyed' },
                                    ],
                                },
                            ],
                            signup: { methods: [] },
                            login: { methods: [], requiredProviders: [] },
                            ui: { autoRedirect: { enabled: false, providerId: null } },
                        },
                    },
                },
            };
            getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });

            const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
            const hook = await renderHook(() => useAuthEntryOptions());
            await flushHookEffects({ cycles: 2, turns: 2 });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(hook.getCurrent().serverAvailability).toBe('unavailable');
            expect(hook.getCurrent().showAuthActions).toBe(false);
            expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(1);

            getCachedServerFeaturesSnapshotMock.mockReturnValue(readySnapshot);
            getServerFeaturesSnapshotMock.mockResolvedValue(readySnapshot);
            await act(async () => {
                serverFeaturesSnapshotListener?.();
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(hook.getCurrent().serverAvailability).toBe('ready');
            expect(hook.getCurrent().showAuthActions).toBe(true);
            expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
            expect(getServerFeaturesSnapshotMock.mock.calls[1]?.[0]?.force).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a slow valid auth-entry read alive until its response arrives', async () => {
        vi.useFakeTimers();
        try {
            getServerFeaturesSnapshotMock.mockResolvedValue({
                status: 'ready',
                features: { capabilities: { auth: { methods: [] } } },
            });
            const entry = createDeferred<{ kind: 'unsupported' }>();
            fetchHomeAuthEntryMock.mockReturnValueOnce(entry.promise);

            const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
            const hook = await renderHook(() => useAuthEntryOptions());
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(fetchHomeAuthEntryMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(hook.getCurrent().serverAvailability).toBe('loading');

            await act(async () => {
                await vi.advanceTimersByTimeAsync(7_000);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(fetchHomeAuthEntryMock.mock.calls[0][0].signal.aborted).toBe(false);
            expect(hook.getCurrent().serverAvailability).toBe('loading');
            entry.resolve({ kind: 'unsupported' });
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(hook.getCurrent().serverAvailability).toBe('ready');
            expect(hook.getCurrent().showAuthActions).toBe(true);
            expect(hook.getCurrent().authEntryUnavailable).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('issues both probes concurrently and keeps the observed feature catalog when auth-entry is unavailable', async () => {
        const features = createDeferred<{ status: 'ready'; features: unknown }>();
        getServerFeaturesSnapshotMock.mockReturnValue(features.promise);
        fetchHomeAuthEntryMock.mockResolvedValue({ kind: 'unavailable' });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(1);
        expect(fetchHomeAuthEntryMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().serverAvailability).toBe('loading');

        features.resolve({
            status: 'ready',
            features: {
                capabilities: {
                    oauth: { providers: { github: { configured: true } } },
                    auth: {
                        methods: [{ id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] }],
                        signup: { methods: [{ id: 'github', enabled: true }] },
                        login: { methods: [], requiredProviders: [] },
                        ui: { autoRedirect: { enabled: false, providerId: null } },
                    },
                },
            },
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const options = hook.getCurrent();
        expect(options.serverAvailability).toBe('ready');
        expect(options.authEntryUnavailable).toBe(true);
        expect(options.showAuthActions).toBe(true);
        expect(options.authenticationActions).toEqual([expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } })]);
    });

    it('keeps a Home-denied auth entry blocked instead of substituting the feature catalog', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: { capabilities: { auth: { methods: [] } } },
        });
        fetchHomeAuthEntryMock.mockResolvedValue({ kind: 'ready', projection: { v: 1, scope: { kind: 'home' }, state: 'denied' } });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().serverAvailability).toBe('unavailable');
        expect(hook.getCurrent().showAuthActions).toBe(false);
    });

    it('consumes a forced retry once when a successful identity-bearing response advances the server generation', async () => {
        let allowReadyResponse = false;
        let identityGenerationBumpsRemaining = 3;
        getServerFeaturesSnapshotMock.mockImplementation(async (params?: { force?: boolean }) => {
            if (!allowReadyResponse) {
                return { status: 'error', reason: 'network' };
            }

            if (params?.force === true && identityGenerationBumpsRemaining > 0) {
                identityGenerationBumpsRemaining -= 1;
                currentActiveServerSnapshot = {
                    ...currentActiveServerSnapshot,
                    generation: currentActiveServerSnapshot.generation + 1,
                };
                activeServerListener?.(currentActiveServerSnapshot);
            }
            return {
                status: 'ready',
                features: { capabilities: { auth: { methods: [] } } },
            };
        });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            hook.getCurrent().retryServerCheck();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(hook.getCurrent().serverAvailability).toBe('unavailable');

        allowReadyResponse = true;
        await act(async () => {
            hook.getCurrent().retryServerCheck();
        });
        await flushHookEffects({ cycles: 8, turns: 4 });

        expect(hook.getCurrent().serverAvailability).toBe('ready');
        expect(hook.getCurrent().showAuthActions).toBe(true);
        expect(hook.getCurrent().authenticationActions).toEqual([]);
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(3);
        expect(getServerFeaturesSnapshotMock.mock.calls.map(([params]) => params?.force)).toEqual([
            false,
            true,
            true,
        ]);
        expect(identityGenerationBumpsRemaining).toBe(2);
    });

    it('syncs to the latest active server on mount when the server changed before the subscription effect attached', async () => {
        let currentSnapshot: TestActiveServerSnapshot = {
            serverId: 'server-example',
            serverUrl: 'http://api.example.test',
            generation: 1,
        };
        getActiveServerSnapshotMock.mockImplementation(() => currentSnapshot);
        subscribeActiveServerMock.mockImplementationOnce((_listener: (snapshot: TestActiveServerSnapshot) => void) => {
            currentSnapshot = {
                serverId: 'server-override',
                serverUrl: 'http://api.override.test',
                generation: 2,
            };
            return () => {};
        });
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    auth: {
                        methods: [
                            {
                                id: 'key_challenge',
                                actions: [
                                    { id: 'login', enabled: true, mode: 'keyed' },
                                    { id: 'provision', enabled: true, mode: 'keyed' },
                                ],
                            },
                        ],
                        signup: { methods: [] },
                        login: { methods: [], requiredProviders: [] },
                        ui: { autoRedirect: { enabled: false, providerId: null } },
                    },
                },
            },
        });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().serverUrlForCopy).toBe('http://api.override.test');
    });

    it('projects the identity-bound Personal Home receipt into auth presentation context', async () => {
        getServerProfileByIdMock.mockReturnValue({
            id: 'server-example',
            name: 'Personal Home',
            serverUrl: 'http://api.example.test',
            serverIdentityId: 'srv_personal_home',
            personalHomeBootstrapCompleted: true,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        });
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: { capabilities: { auth: { methods: [] } } },
        });

        const { useAuthEntryOptions } = await import('./useAuthEntryOptions');
        const hook = await renderHook(() => useAuthEntryOptions());
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().isPersonalHome).toBe(true);
    });
});
