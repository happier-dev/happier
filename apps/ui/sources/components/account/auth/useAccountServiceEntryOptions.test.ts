import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { resolveAccountServiceEntryProbeTarget } from './useAccountServiceEntryOptions';

const endpointRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/http/client')>();
    return {
        ...actual,
        createServerFetchAtEndpoint: () => endpointRequestMock,
    };
});

const deviceSelection = {
    url: 'https://api.happier.dev',
    source: 'default',
} as const;

describe('resolveAccountServiceEntryProbeTarget', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        endpointRequestMock.mockReset();
    });

    it('offers no discovery target before an unconfigured source build selects a service', () => {
        expect(resolveAccountServiceEntryProbeTarget({
            targetContext: { kind: 'none' }, deviceSelection: { url: '', source: 'default' },
        })).toEqual({ effective: { kind: 'not_offered' }, probe: null });
    });

    it('creates no probe for absent or disabled targeted policy', () => {
        expect(resolveAccountServiceEntryProbeTarget({
            targetContext: {
                kind: 'home',
                target: { kind: 'https_url', url: 'https://home.example.test' },
            },
            deviceSelection,
        }).probe).toBeNull();
        expect(resolveAccountServiceEntryProbeTarget({
            targetContext: {
                kind: 'home',
                target: { kind: 'https_url', url: 'https://home.example.test' },
                policy: { v: 1, mode: 'disabled' },
            },
            deviceSelection,
        }).probe).toBeNull();
    });

    it('keys self discovery by exact endpoint, identity, and carrier', () => {
        const homeCarrier = {
            endpointId: 'iroh-1',
            readObservedPath: () => 'relay' as const,
            request: async () => new Response(),
            createWebSocket: () => ({}),
        };
        const result = resolveAccountServiceEntryProbeTarget({
            targetContext: {
                kind: 'home',
                target: { kind: 'https_url', url: 'https://home.example.test' },
                policy: { v: 1, mode: 'self' },
                selfService: {
                    endpointUrl: 'https://home.example.test',
                    expectedServerIdentityId: 'srv_home',
                    homeCarrier,
                },
            },
            deviceSelection,
        });

        expect(result.probe).toMatchObject({
            endpoint: { url: 'https://home.example.test', serverIdentityId: 'srv_home' },
            transport: { homeCarrier },
        });
        expect(result.probe?.key).toContain('iroh-1');
    });

    it('settles a default no-target discovery across an unrelated caller render', async () => {
        const features = buildServerFeaturesResponse();
        const featuresResponse = {
            ...features,
            capabilities: {
                ...features.capabilities,
                accountDirectory: {
                    version: 1,
                    homeDirectory: true,
                    homeEnrollment: true,
                    homeLoginAssertion: {
                        keyId: 'a'.repeat(64),
                        publicKeyBase64Url: 'A'.repeat(43),
                    },
                },
                server: { canonicalServerUrl: 'https://accounts.example.test' },
                serverIdentity: { serverIdentityId: 'srv_accounts' },
                auth: {
                    ...features.capabilities.auth,
                    methods: [{
                        id: 'key_challenge',
                        actions: [{ id: 'login', enabled: true, mode: 'keyed' }],
                    }],
                    keyChallenge: { v2: true },
                },
            },
        };
        const authEntryResponse = {
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'key_challenge',
                action: 'login',
                mode: 'keyed',
                origin: 'home',
                presentation: { displayName: 'Device key' },
            }],
            autoRedirect: null,
        };
        endpointRequestMock.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/features' ? featuresResponse : authEntryResponse,
        ), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await setAccountServiceEndpoint({ url: 'https://accounts.example.test', source: 'default' });

        let renderCount = 0;
        const { useAccountServiceEntryOptions } = await import('./useAccountServiceEntryOptions');
        const hook = await renderHook(({ unrelated, inlineContext }: { unrelated: number; inlineContext: boolean }) => {
            void unrelated;
            renderCount += 1;
            return inlineContext
                ? useAccountServiceEntryOptions({ kind: 'none' })
                : useAccountServiceEntryOptions();
        }, { initialProps: { unrelated: 0, inlineContext: false } });

        try {
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            const settledRenderCount = renderCount;
            await hook.rerender({ unrelated: 1, inlineContext: true });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(hook.getCurrent().status).toBe('ready');
            expect(endpointRequestMock).toHaveBeenCalledTimes(2);
            expect(renderCount).toBeLessThanOrEqual(settledRenderCount + 1);
        } finally {
            await hook.unmount();
            standardCleanup();
        }
    });
});
