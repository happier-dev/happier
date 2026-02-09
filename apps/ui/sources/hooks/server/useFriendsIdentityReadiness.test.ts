import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useFriendsIdentityReadiness', () => {
    it('returns needsProvider when provider mode is enabled and required provider is missing', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: true },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false, configured: false, provider: null },
                        social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                        oauth: { providers: { github: { enabled: true, configured: true } } },
                        auth: {
                            signup: { methods: [{ id: 'anonymous', enabled: true }] },
                            login: { requiredProviders: [] },
                            recovery: { providerReset: { enabled: false, providers: [] } },
                            ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                            providers: {},
                            misconfig: [],
                        },
                    },
                }),
            })) as any,
        );

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen: Array<string> = [];
        function Test() {
            const readiness = useFriendsIdentityReadiness();
            React.useEffect(() => {
                seen.push(readiness.reason);
            }, [readiness.reason]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen).toContain('loadingFeatures');
        expect(seen.at(-1)).toBe('needsProvider');
    });

    it('returns ready when required provider is connected and username is present', async () => {
        vi.resetModules();
        storage.getState().applyProfile({
            ...profileDefaults,
            username: 'octocat',
            linkedProviders: [{
                id: 'github',
                login: 'octocat',
                displayName: 'Octocat',
                avatarUrl: '',
                profileUrl: '',
                showOnProfile: true,
            }],
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: true },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false, configured: false, provider: null },
                        social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                        oauth: { providers: { github: { enabled: true, configured: true } } },
                        auth: {
                            signup: { methods: [{ id: 'anonymous', enabled: true }] },
                            login: { requiredProviders: [] },
                            recovery: { providerReset: { enabled: false, providers: [] } },
                            ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                            providers: {},
                            misconfig: [],
                        },
                    },
                }),
            })) as any,
        );

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen: Array<string> = [];
        function Test() {
            const readiness = useFriendsIdentityReadiness();
            React.useEffect(() => {
                seen.push(readiness.reason);
            }, [readiness.reason]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toBe('ready');
    });
});
