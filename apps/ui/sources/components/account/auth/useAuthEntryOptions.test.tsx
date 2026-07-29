import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn());
const subscribeActiveServerMock = vi.hoisted(() => vi.fn());
const getAuthProviderMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: getActiveServerSnapshotMock,
    subscribeActiveServer: subscribeActiveServerMock,
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: getAuthProviderMock,
}));

const textMock = createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) => {
        if (key === 'welcome.signUpWithProvider' && typeof params?.provider === 'string') {
            return `Sign up with ${params.provider}`;
        }
        if (key === 'welcome.signInWithCertificate') return 'Sign in with certificate';
        if (key === 'welcome.createAccount') return 'Create account';
        if (key === 'status.unknown') return 'Unknown';
        return key;
    },
});

vi.mock('@/text', () => textMock);

describe('useAuthEntryOptions', () => {
    type TestActiveServerSnapshot = Readonly<{
        serverId: string;
        serverUrl: string;
        generation: number;
    }>;
    let activeServerListener: ((snapshot: TestActiveServerSnapshot) => void) | null = null;
    let currentActiveServerSnapshot: TestActiveServerSnapshot;

    beforeEach(() => {
        getServerFeaturesSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReset();
        subscribeActiveServerMock.mockReset();
        getAuthProviderMock.mockReset();
        currentActiveServerSnapshot = {
            serverId: 'server-example',
            serverUrl: 'http://api.example.test',
            generation: 1,
        };
        getActiveServerSnapshotMock.mockImplementation(() => currentActiveServerSnapshot);
        activeServerListener = null;
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
        expect(options.showProviderSignup).toBe(true);
        expect(options.showAnonymousSignup).toBe(true);
        expect(options.showMtlsLogin).toBe(true);
        expect(options.providerSignupTitle).toContain('GitHub');
        expect(options.mtlsTitle).toBe('Sign in with certificate');
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

    it('re-checks an unavailable relay when the same active URL is restored with a new generation', async () => {
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

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent().serverAvailability).toBe('legacy');
        expect(hook.getCurrent().showAuthActions).toBe(true);
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

        expect(hook.getCurrent().serverAvailability).toBe('legacy');
        expect(hook.getCurrent().showAuthActions).toBe(true);
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(4);
        expect(getServerFeaturesSnapshotMock.mock.calls.map(([params]) => params?.force)).toEqual([
            false,
            true,
            true,
            false,
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
});
