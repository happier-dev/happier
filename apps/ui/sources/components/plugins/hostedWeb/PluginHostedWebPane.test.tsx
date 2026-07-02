import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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
    hostedWebById: {
        'hostedWeb:acme.preview:preview-web': {
            id: 'hostedWeb:acme.preview:preview-web',
            pluginId: 'acme.preview',
            contributionKind: 'hostedWeb',
            contributionId: 'preview-web',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
        },
    },
};

describe('PluginHostedWebPane', () => {
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

    it('renders the host frame only for preview-policy-accepted URLs', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceId="sessionSurface:acme.preview:preview-pane"
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        const frame = screen.findByTestId('plugin-hosted-web-frame');
        expect(frame).toBeTruthy();
        expect(frame?.props.src).toBe('https://preview.happier.test/plugin/acme/');
        expect(frame?.props.sandbox).toBe('allow-scripts');
        expect(frame?.props.referrerPolicy).toBe('no-referrer');
    });

    it('forwards only nonce-bound hosted web bridge messages from the expected origin', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const onBridgeMessage = vi.fn();
        const listeners = new Set<(event: MessageEvent) => void>();
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
            const screen = await renderScreen(<PluginHostedWebPane
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
            />);

            const frame = screen.findByTestId('plugin-hosted-web-frame');
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

        const frame = screen.findByTestId('plugin-hosted-web-frame');
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
});
