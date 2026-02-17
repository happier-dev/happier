import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useFriendsIdentityReadiness', () => {
    it('returns needsUsername when username mode is enabled and no provider is required by server features', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        bugReports: { enabled: true },
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: true },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false },
                        social: { friends: { enabled: true } },
                        auth: {
                            recovery: { providerReset: { enabled: false } },
                            ui: { recoveryKeyReminder: { enabled: true } },
                        },
                    },
                    capabilities: {
                        social: { friends: { allowUsername: true, requiredIdentityProviderId: null } },
                        oauth: { providers: { github: { enabled: true, configured: false } } },
                    },
                }),
            })) as any,
        );

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen: Array<{ reason: string; requiredProviderId: string | null; gateVariant: string }> = [];
        function Test() {
            const readiness = useFriendsIdentityReadiness();
            React.useEffect(() => {
                seen.push({
                    reason: readiness.reason,
                    requiredProviderId: readiness.requiredProviderId,
                    gateVariant: readiness.gate.gateVariant,
                });
            }, [readiness.reason, readiness.requiredProviderId, readiness.gate.gateVariant]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.map((s) => s.reason)).toContain('loadingFeatures');
        expect(seen.at(-1)?.reason).toBe('needsUsername');
        expect(seen.at(-1)?.requiredProviderId).toBe(null);
        expect(seen.at(-1)?.gateVariant).toBe('username');
    });

    it('returns needsProvider when provider mode is enabled and required provider is missing', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        bugReports: { enabled: true },
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: true },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false },
                        social: { friends: { enabled: true } },
                        auth: {
                            recovery: { providerReset: { enabled: false } },
                            ui: { recoveryKeyReminder: { enabled: true } },
                        },
                    },
                    capabilities: {
                        social: { friends: { allowUsername: false, requiredIdentityProviderId: 'github' } },
                        oauth: { providers: { github: { enabled: true, configured: true } } },
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
                        bugReports: { enabled: true },
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: true },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false },
                        social: { friends: { enabled: true } },
                        auth: {
                            recovery: { providerReset: { enabled: false } },
                            ui: { recoveryKeyReminder: { enabled: true } },
                        },
                    },
                    capabilities: {
                        social: { friends: { allowUsername: false, requiredIdentityProviderId: 'github' } },
                        oauth: { providers: { github: { enabled: true, configured: true } } },
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
