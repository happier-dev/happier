import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiResourceSubscriptionEventV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import {
    createCanonicalPluginReactNativeHostApiAdapter,
    createPluginReactNativeHostApiAdapter,
} from './hostApi';

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    surfaceId: 'surface_1',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

describe('React Native plugin Host API adapter', () => {
    it('maps supported RN calls onto the canonical Host API request vocabulary', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest: async (request) => {
                requests.push(request);
                return { accepted: true, method: request.method };
            },
        });

        expect(adapter.api.getSurfaceContext()).toEqual(surface);
        await expect(adapter.api.requestSessionResource({ resource: { kind: 'session' } }))
            .resolves.toEqual({ accepted: true, method: 'requestSessionResource' });
        await adapter.api.dispatchAction({ actionId: 'plugin.preview.open' });
        await adapter.api.openSurface({ contributionId: 'details' });
        await adapter.api.copy({ text: 'copied text' });
        await adapter.api.openExternal({ url: 'https://docs.example.test/plugin' });
        await expect(adapter.api.logDiagnostic({ severity: 'info', message: 'rendered' }))
            .resolves.toBeUndefined();

        expect(requests.map((request) => request.method)).toEqual([
            'requestSessionResource',
            'dispatchAction',
            'openSurface',
            'copy',
            'openExternal',
            'logDiagnostic',
        ]);
        expect(requests.every((request) => request.surface === surface)).toBe(true);
    });

    it('rejects stale surfaces and unknown methods before host dispatch', async () => {
        const handleRequest = vi.fn();
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest,
            isSurfaceCurrent: () => false,
        });

        await expect(adapter.api.requestSessionResource({ resource: { kind: 'session' } }))
            .rejects.toMatchObject({ code: 'stale_surface' });
        await expect(adapter.api.request('rawStoreAccess' as never, {}))
            .rejects.toMatchObject({ code: 'unsupported_method' });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('disposes subscriptions and suppresses later events for the disposed subscription id', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const events: PluginUiResourceSubscriptionEventV1[] = [];
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest: async (request) => {
                requests.push(request);
                return { accepted: true };
            },
        });

        const subscription = await adapter.api.subscribeResource(
            { subscriptionId: 'sub-1', resource: { kind: 'localService', idPath: '/services/0/id' } },
            (event) => events.push(event),
        );
        expect(adapter.publishSubscriptionEvent({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'snapshot',
            snapshot: {
                resource: { kind: 'localService', idPath: '/services/0/id' },
                state: 'available',
                capturedAtMs: 1,
                diagnostics: [],
                payload: { status: 'ready' },
            },
        })).toBe(true);

        await subscription.unsubscribe();

        expect(adapter.publishSubscriptionEvent({
            version: 1,
            subscriptionId: 'sub-1',
            kind: 'complete',
            diagnostics: [],
        })).toBe(false);
        expect(events).toHaveLength(1);
        expect(requests.map((request) => request.method)).toEqual([
            'subscribeResource',
            'unsubscribeResource',
        ]);
    });

    it('retires a subscription that settles after the surface is disposed', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        let settleSubscribe: (() => void) | undefined;
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest: async (request) => {
                requests.push(request);
                if (request.method === 'subscribeResource') {
                    await new Promise<void>((resolve) => {
                        settleSubscribe = resolve;
                    });
                }
                return { accepted: true };
            },
        });

        const subscription = adapter.api.subscribeResource(
            { subscriptionId: 'sub-racing-retirement', resource: { kind: 'localService', idPath: '/services/0/id' } },
            () => undefined,
        );
        await vi.waitFor(() => {
            expect(requests.map((request) => request.method)).toEqual(['subscribeResource']);
        });

        adapter.dispose();
        settleSubscribe?.();

        await expect(subscription).rejects.toMatchObject({ code: 'stale_surface' });
        await vi.waitFor(() => {
            expect(requests.map((request) => request.method)).toEqual([
                'subscribeResource',
                'unsubscribeResource',
            ]);
        });
    });

    it('retires settled host subscriptions when the surface is disposed', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest: async (request) => {
                requests.push(request);
                return { accepted: true };
            },
        });

        await adapter.api.subscribeResource(
            { subscriptionId: 'sub-active-at-retirement', resource: { kind: 'localService', idPath: '/services/0/id' } },
            () => undefined,
        );
        adapter.dispose();

        await vi.waitFor(() => {
            expect(requests.map((request) => request.method)).toEqual([
                'subscribeResource',
                'unsubscribeResource',
            ]);
        });
    });

    it('keeps action dispatch behind the declared method boundary', async () => {
        const handleRequest = vi.fn();
        const adapter = createPluginReactNativeHostApiAdapter({
            surface,
            requestIdPrefix: 'rn',
            handleRequest,
            allowedMethods: ['requestSessionResource'],
        });

        await expect(adapter.api.dispatchAction({ actionId: 'plugin.preview.open' }))
            .rejects.toMatchObject({ code: 'denied' });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('preserves settled one-shot side effects when generation retirement races result delivery', async () => {
        const canonicalSurface = {
            placement: 'session.preview' as const,
            platform: 'web' as const,
            locale: 'en',
            direction: 'ltr' as const,
            colorScheme: 'light' as const,
            contrast: 'normal' as const,
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            session: { id: 'session-1' },
        };
        const operations = [
            {
                expected: { token: 'known-success' },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.executeAction('plugin.preview.open', null),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.openSurface('plugin.preview.details'),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.writeClipboard('known output'),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.openExternalLink('https://docs.example.test/plugin'),
            },
        ];

        for (const operation of operations) {
            let adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>;
            adapter = createCanonicalPluginReactNativeHostApiAdapter({
                surface: canonicalSurface,
                legacySurface: surface,
                requestIdPrefix: 'rn-v2',
                handleRequest: async () => {
                    adapter.dispose();
                    return { token: 'known-success' };
                },
            });

            await expect(operation.invoke(adapter)).resolves.toEqual(operation.expected);
        }
    });

    it('rejects settled reads when generation retirement races result delivery', async () => {
        const canonicalSurface = {
            placement: 'session.preview' as const,
            platform: 'web' as const,
            locale: 'en',
            direction: 'ltr' as const,
            colorScheme: 'light' as const,
            contrast: 'normal' as const,
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            session: { id: 'session-1' },
        };
        const operations: readonly Readonly<{
            result: PluginUiJsonValueV1;
            invoke: (
                adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>,
            ) => Promise<unknown>;
        }>[] = [
            {
                result: {
                    contentType: 'text/plain',
                    digest: 'sha256:resource',
                    bytesBase64: 'aGVsbG8=',
                },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.readResource('plugin.preview.resource'),
            },
            {
                result: { value: 'stale clipboard' },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.readClipboard(),
            },
        ];

        for (const operation of operations) {
            let adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>;
            adapter = createCanonicalPluginReactNativeHostApiAdapter({
                surface: canonicalSurface,
                legacySurface: surface,
                requestIdPrefix: 'rn-v2',
                handleRequest: async () => {
                    adapter.dispose();
                    return operation.result;
                },
            });

            await expect(operation.invoke(adapter)).rejects.toMatchObject({ code: 'stale_surface' });
        }
    });

    it('retires a canonical resource watch only after its in-flight subscribe settles', async () => {
        const canonicalSurface = {
            placement: 'session.preview' as const,
            platform: 'web' as const,
            locale: 'en',
            direction: 'ltr' as const,
            colorScheme: 'light' as const,
            contrast: 'normal' as const,
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            session: { id: 'session-1' },
        };
        let settleSubscribe: (() => void) | undefined;
        let subscribeSettled = false;
        let hostSubscriptionActive = false;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            legacySurface: surface,
            requestIdPrefix: 'rn-v2',
            handleRequest: async (request) => {
                if (request.method === 'subscribeResource') {
                    await new Promise<void>((resolve) => {
                        settleSubscribe = resolve;
                    });
                    hostSubscriptionActive = true;
                    subscribeSettled = true;
                }
                if (request.method === 'unsubscribeResource') {
                    hostSubscriptionActive = false;
                }
                return { accepted: true };
            },
        });

        adapter.api.watchResource('plugin.preview.resource', () => undefined);
        await vi.waitFor(() => {
            expect(settleSubscribe).toBeTypeOf('function');
        });
        adapter.dispose();
        settleSubscribe?.();

        await vi.waitFor(() => {
            expect(subscribeSettled).toBe(true);
        });
        expect(hostSubscriptionActive).toBe(false);
    });
});
