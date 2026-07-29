import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const projection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        'acme.preview': {
            id: 'translations:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'translations',
            locales: ['en'],
            bundles: {
                en: {
                    'preview.frame.title': 'Preview panel',
                },
            },
        },
    },
    hostedWebById: {
        'hostedWeb:acme.preview:preview-web': {
            id: 'hostedWeb:acme.preview:preview-web',
            pluginId: 'acme.preview',
            contributionKind: 'hostedWeb',
            contributionId: 'preview-web',
            display: {
                titleKey: 'preview.frame.title',
                developerFallback: 'Preview',
            },
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
};

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function findHostedWebIframe(screen: RenderedScreen) {
    const frames = screen.root.findAllByType('iframe');
    expect(frames).toHaveLength(1);
    return frames[0];
}

describe('PluginHostedWebPane', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders unavailable when the preview endpoint has not been projected yet', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('fails closed when projection runtime policy does not make hosted-web executable', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const disabledProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['feature_disabled'],
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={disabledProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('renders the host frame only for preview-policy-accepted URLs', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.src).toContain('https://preview.happier.test/plugin/acme/');
        expect(frame?.props.src).toContain('happierBridgeNonce=');
        expect(frame?.props.sandbox).toBe('allow-scripts');
        expect(frame?.props.referrerPolicy).toBe('no-referrer');
        expect(frame?.props.title).toBe('Preview panel');
    });

    it('renders only when a hosted-web security policy is present and valid', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const policyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    sandbox: { scripts: true, sameOrigin: true },
                    security: {
                        allowedCallbackOrigins: ['https://oauth.example.test'],
                        csp: {
                            connectSrc: 'selfOnly',
                            allowEval: false,
                        },
                        mixedContent: 'deny',
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.referrerPolicy).toBe('no-referrer');
        expect(frame?.props.sandbox).toContain('allow-same-origin');
    });

    it('fails closed when non-static hosted-web endpoints request unenforceable CSP widening', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const managedProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'managedService', serviceId: 'preview-dev' },
                    security: {
                        allowedConnectOrigins: ['https://api.example.test'],
                        csp: {
                            connectSrc: 'declaredOrigins',
                            allowEval: false,
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={managedProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('forwards only nonce-bound hosted web bridge messages from the expected origin', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const onBridgeMessage = vi.fn();
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({
                        bridgeNonce: 'nonce-1',
                        onBridgeMessage,
                        sessionId: 'session-1',
                    } as any)}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            const frame = findHostedWebIframe(screen);
            expect(frame?.props.src).toContain('happierBridgeNonce=nonce-1');

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://evil.example.test',
                    data: {
                        version: 1,
                        pluginId: 'acme.preview',
                        contributionId: 'preview-web',
                        surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        pluginId: 'acme.preview',
                        contributionId: 'preview-web',
                        surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(onBridgeMessage).toHaveBeenCalledTimes(1);
            expect(onBridgeMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'ready',
                nonce: 'nonce-1',
            }));
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('uses cryptographic getRandomValues for bridge nonce fallback when randomUUID is unavailable', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Math.random must not be used for bridge nonce generation');
        });
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: {
                getRandomValues: (array: Uint8Array) => {
                    array.fill(0x7a);
                    return array;
                },
            },
        });

        try {
            const screen = await renderScreen(<PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceId="sessionSurface:acme.preview:preview-pane"
                pluginUiProjection={projection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                onBridgeMessage={() => undefined}
            />);

            const frame = findHostedWebIframe(screen);
            expect(frame?.props.src).toContain('happierBridgeNonce=7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a');
            expect(randomSpy).not.toHaveBeenCalled();
        } finally {
            randomSpy.mockRestore();
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('rotates bridge authority when the daemon projection generation changes', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('generation-one')
            .mockReturnValueOnce('generation-two');
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: { randomUUID },
        });
        const element = (generation: number) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceId="sessionSurface:acme.preview:preview-pane"
                pluginUiProjection={{ ...projection, generation }}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                onBridgeMessage={() => undefined}
            />
        );

        try {
            const screen = await renderScreen(element(1));
            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=generation-one');

            await screen.update(element(2));

            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=generation-two');
            expect(randomUUID).toHaveBeenCalledTimes(2);
        } finally {
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('restarts hosted-web readiness authority when the daemon projection generation changes', async () => {
        vi.useFakeTimers();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const hostApi = {
            platform: 'web' as const,
            channel: 'internal' as const,
            handleRequest: vi.fn(async () => null),
        };
        const element = (generation: number) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceId="sessionSurface:acme.preview:preview-pane"
                pluginUiProjection={{ ...projection, generation }}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                bridgeNonce="nonce-1"
                hostApi={hostApi}
                readyTimeoutMs={10}
            />
        );

        const screen = await renderScreen(element(1));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6);
        });

        await screen.update(element(2));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('returns typed host API responses to allowed hosted-web bridge requests', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };

        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['requestSessionResource'] },
                },
            },
        };
        const handleRequest = vi.fn(async () => ({ state: 'available', title: 'Preview' }));

        try {
            await renderScreen(
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    bridgeNonce="nonce-1"
                    sessionId="session-1"
                    surfacePlacement="browserSurface"
                    hostApi={{
                        platform: 'web',
                        channel: 'internal',
                        handleRequest,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        pluginId: 'acme.preview',
                        contributionId: 'preview-web',
                        surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 2,
                        kind: 'requestSessionResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(iframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                version: 1,
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
                surfaceId: 'sessionSurface:acme.preview:preview-pane',
                requestSequence: 2,
                kind: 'result',
                payload: { state: 'available', title: 'Preview' },
            }), 'https://preview.happier.test');
            expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
                surface: expect.objectContaining({
                    placement: 'browserSurface',
                }),
            }));
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('keeps the hosted snapshot mounted while host API is unavailable and restores requests after reconnect', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['requestSessionResource'] },
                },
            },
        };
        const handleRequest = vi.fn(async () => ({ state: 'available' }));
        const hostApi: NonNullable<React.ComponentProps<typeof PluginHostedWebPane>['hostApi']> = {
            platform: 'web',
            channel: 'internal',
            handleRequest,
        };
        const element = (interactionEnabled: boolean) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceId="sessionSurface:acme.preview:preview-pane"
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                bridgeNonce="nonce-1"
                sessionId="session-1"
                hostApi={hostApi}
                interactionEnabled={interactionEnabled}
            />
        );

        try {
            const screen = await renderScreen(element(false), {
                createNodeMock: (node) => (
                    (node as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            });
            expect(findHostedWebIframe(screen).props.src).toContain('happierBridgeNonce=nonce-1');
            const offlineBoundary = screen.findByTestId(
                'plugin-surface-snapshot:sessionSurface:acme.preview:preview-pane',
            );
            expect(offlineBoundary?.props).toMatchObject({
                inert: true,
                'aria-hidden': true,
            });
            expect(offlineBoundary?.props.style).toMatchObject({ pointerEvents: 'none' });
            expect(screen.findByTestId(
                'plugin-surface-offline-summary:sessionSurface:acme.preview:preview-pane',
            )?.props.role).toBe('status');
            const pointerEvent = {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            };
            const keyboardEvent = {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            };
            offlineBoundary?.props.onClickCapture(pointerEvent);
            offlineBoundary?.props.onKeyDownCapture(keyboardEvent);
            expect(pointerEvent.preventDefault).toHaveBeenCalledTimes(1);
            expect(pointerEvent.stopPropagation).toHaveBeenCalledTimes(1);
            expect(keyboardEvent.preventDefault).toHaveBeenCalledTimes(1);
            expect(keyboardEvent.stopPropagation).toHaveBeenCalledTimes(1);

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        pluginId: 'acme.preview',
                        contributionId: 'preview-web',
                        surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 3,
                        kind: 'requestSessionResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });
            expect(iframeSource.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
                requestSequence: 3,
                kind: 'error',
                payload: expect.objectContaining({ code: 'unavailable' }),
            }), 'https://preview.happier.test');
            expect(handleRequest).not.toHaveBeenCalled();

            await screen.update(element(true));
            const reconnectedBoundary = screen.findByTestId(
                'plugin-surface-snapshot:sessionSurface:acme.preview:preview-pane',
            );
            expect(reconnectedBoundary?.props.inert).toBe(false);
            expect(reconnectedBoundary?.props['aria-hidden']).toBe(false);
            expect(reconnectedBoundary?.props.style).toMatchObject({ pointerEvents: 'auto' });
            expect(screen.findByTestId(
                'plugin-surface-offline-summary:sessionSurface:acme.preview:preview-pane',
            )).toBeNull();
            expect(findHostedWebIframe(screen).props.src).toContain('happierBridgeNonce=nonce-1');
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        pluginId: 'acme.preview',
                        contributionId: 'preview-web',
                        surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 4,
                        kind: 'requestSessionResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });
            expect(handleRequest).toHaveBeenCalledTimes(1);
            expect(iframeSource.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
                requestSequence: 4,
                kind: 'result',
            }), 'https://preview.happier.test');
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('falls back when hosted-web bridge ready is not received before the host timeout', async () => {
        vi.useFakeTimers();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const handleRequest = vi.fn();
        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
            bridgeNonce="nonce-1"
            hostApi={{
                platform: 'web',
                channel: 'internal',
                handleRequest,
            }}
            readyTimeoutMs={5}
        />);

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('does not honor same-origin sandbox requests for path-fallback hosted web endpoints', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const pathFallbackProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    entry: { routeMode: 'pathFallback', path: '/' },
                    sandbox: { scripts: true, sameOrigin: true },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={pathFallbackProjection}
            endpointUrl="https://app.happier.test/v1/local-services/preview/preview_1/"
            platform="web"
        />);

        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.sandbox).toContain('allow-scripts');
        expect(frame?.props.sandbox).not.toContain('allow-same-origin');
    });

    it('does not render daemon loopback endpoints on native clients', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="http://127.0.0.1:5173/"
            platform="ios"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('does not render loopback aliases or IPv4-mapped loopback endpoints on native clients', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const ipv4Alias = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="http://127.1.2.3:5173/"
            platform="ios"
        />);
        const mappedIpv6 = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="http://[::ffff:127.0.0.1]:5173/"
            platform="android"
        />);

        expect(ipv4Alias.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(mappedIpv6.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    describe('native dev-loopback relaxation (RN-WEB-LOADER item 6)', () => {
        type DevGlobal = typeof globalThis & { __DEV__?: boolean };

        function stubDevBuild(enabled: boolean): () => void {
            const devGlobal = globalThis as DevGlobal;
            const hadOwnDevFlag = Object.prototype.hasOwnProperty.call(devGlobal, '__DEV__');
            const previousDevFlag = devGlobal.__DEV__;
            vi.stubGlobal('__DEV__', enabled);
            return () => {
                if (hadOwnDevFlag) {
                    vi.stubGlobal('__DEV__', previousDevFlag);
                } else {
                    Reflect.deleteProperty(devGlobal, '__DEV__');
                }
            };
        }

        const devLoopbackProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: { mixedContent: 'devLoopbackOnly' },
                },
            },
        };

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('still blocks a devLoopbackOnly + development-channel endpoint on native in a PRODUCTION build (fail-closed default unchanged)', async () => {
            const restore = stubDevBuild(false);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('still blocks a devLoopbackOnly endpoint on native in a dev build when the channel is NOT development', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'internal', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('still blocks a development-channel loopback endpoint on native in a dev build when security does NOT declare devLoopbackOnly', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={projection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('renders a devLoopbackOnly + development-channel loopback endpoint on native ONLY in a dev build (all three conditions hold)', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceId="sessionSurface:acme.preview:preview-pane"
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('leaves production HTTPS-served hostedWeb endpoints unaffected on native (Q2: not a gap)', async () => {
            const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
            const screen = await renderScreen(<PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceId="sessionSurface:acme.preview:preview-pane"
                pluginUiProjection={projection}
                endpointUrl="https://plugin.example.test/"
                platform="ios"
            />);
            expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        });
    });

    it('renders a platform-compatible hosted-web projection and hides incompatible platforms', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const policyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    compatibility: { platforms: ['web'] },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);
        const native = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="ios"
        />);

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(native.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('fails closed when hosted-web security policy is absent or malformed', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const missingPolicyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: undefined,
                },
            },
        };
        const malformedPolicyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: {
                        allowedConnectOrigins: ['https://preview.happier.test/*'],
                    },
                },
            },
        };

        const missing = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={missingPolicyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);
        const malformed = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={malformedPolicyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(missing.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(malformed.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });
});
