import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

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
    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
            },
            voice: {
                enabled: params.voiceEnabled,
                configured: params.voiceEnabled,
                provider: params.voiceEnabled ? 'elevenlabs' : null,
            },
            social: {
                friends: {
                    enabled: false,
                    allowUsername: false,
                    requiredIdentityProviderId: 'github',
                },
            },
            oauth: { providers: {} },
            auth: {
                signup: { methods: [] },
                login: { requiredProviders: [] },
                recovery: { providerReset: { enabled: false, providers: [] } },
                ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                providers: {},
                misconfig: [],
            },
        },
    };
}

function emitActiveServerChanged(next: { serverId: string; serverUrl: string; generation: number }) {
    activeServerRef.current = next;
    for (const listener of activeServerListeners.listeners) {
        listener(next);
    }
}

describe('featureDecisionRuntime', () => {
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
});

