import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';

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

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'welcome.signUpWithProvider' && typeof params?.provider === 'string') {
            return `Sign up with ${params.provider}`;
        }
        if (key === 'welcome.signInWithCertificate') return 'Sign in with certificate';
        if (key === 'welcome.createAccount') return 'Create account';
        if (key === 'status.unknown') return 'Unknown';
        return key;
    },
}));

describe('useAuthEntryOptions', () => {
    let activeServerListener: ((snapshot: { serverUrl: string }) => void) | null = null;

    beforeEach(() => {
        getServerFeaturesSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReset();
        subscribeActiveServerMock.mockReset();
        getAuthProviderMock.mockReset();
        getActiveServerSnapshotMock.mockReturnValue({ serverUrl: 'http://api.example.test' });
        activeServerListener = null;
        subscribeActiveServerMock.mockImplementation((listener: (snapshot: { serverUrl: string }) => void) => {
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
            activeServerListener?.({ serverUrl: 'http://api.other.test' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const options = hook.getCurrent();
        expect(options.serverUrlForCopy).toBe('http://api.other.test');
        expect(options.serverAvailability).toBe('incompatible');
        expect(options.showAuthActions).toBe(false);
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledTimes(2);
    });
});
