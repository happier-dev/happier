import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useAutomationsSupport', () => {
    it('disables automations when experiments are off even if server enables them', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        const seen: Array<any> = [];
        function Test() {
            const value = useAutomationsSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        // experiments defaults to false, so automations must be gated off
        expect(seen.at(-1)).toMatchObject({ enabled: false });
    });

    it('returns enabled capability details when automations are enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            getStorage().getState().applySettingsLocal({ experiments: true });
        });

        const seen: Array<any> = [];
        function Test() {
            const value = useAutomationsSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toMatchObject({ enabled: true });
    });

    it('returns disabled capability details when automations are disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: false });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            getStorage().getState().applySettingsLocal({ experiments: true });
        });

        const seen: Array<any> = [];
        function Test() {
            const value = useAutomationsSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toMatchObject({ enabled: false });
    });

    it('disables automations when local expAutomations gate is off', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true });

        const [{ useAutomationsSupport }, { getStorage }] = await Promise.all([
            import('./useAutomationsSupport'),
            import('@/sync/domains/state/storage'),
        ]);
        await act(async () => {
            getStorage().getState().applySettingsLocal({
                experiments: true,
                featureToggles: { automations: false },
            });
        });

        const seen: Array<any> = [];
        function Test() {
            const value = useAutomationsSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toMatchObject({ enabled: false });
        await act(async () => {
            getStorage().getState().applySettingsLocal({
                featureToggles: { automations: true },
            });
        });
    });

    it('fails closed when feature request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        const seen: Array<any> = [];
        function Test() {
            const value = useAutomationsSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        // Legacy/unsupported servers (or failed feature fetch) must gate the UI off.
        expect(seen.at(-1)).toMatchObject({ enabled: false });
    });

    it('uses spawn scope when provided', async () => {
        vi.resetModules();

        const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { getStorage } = await import('@/sync/domains/state/storage');

        resetServerFeaturesClientForTests();

        const serverA = upsertServerProfile({ serverUrl: 'https://a.example', name: 'A', source: 'manual' });
        const serverB = upsertServerProfile({ serverUrl: 'https://b.example', name: 'B', source: 'manual' });
        setActiveServerId(serverA.id, { scope: 'device' });

        await act(async () => {
            getStorage().getState().applySettingsLocal({
                experiments: true,
                featureToggles: { automations: true },
            });
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: any) => {
                const href = String(url ?? '');
                if (href.includes('a.example')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => buildServerFeaturesResponse({ automationsEnabled: false }),
                    };
                }
                if (href.includes('b.example')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => buildServerFeaturesResponse({ automationsEnabled: true }),
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => buildServerFeaturesResponse({ automationsEnabled: false }),
                };
            }) as any,
        );

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        const seen: Array<any> = [];
        function Test() {
            const value = (useAutomationsSupport as any)({ scopeKind: 'spawn', serverId: serverB.id });
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toMatchObject({ enabled: true });
    });
});
