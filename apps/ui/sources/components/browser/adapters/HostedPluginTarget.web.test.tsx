import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { HostedPluginTarget } from './HostedPluginTarget.web';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

function createHostedPluginSecurityPolicy(
    overrides?: Partial<PluginHostedWebSecurityPolicyV1>,
): PluginHostedWebSecurityPolicyV1 {
    return {
        allowedNavigationOrigins: [],
        allowedCallbackOrigins: [],
        allowedConnectOrigins: [],
        csp: {
            scriptSrc: 'selfOnly',
            styleSrc: 'selfOnly',
            imgSrc: 'selfOnly',
            fontSrc: 'selfOnly',
            connectSrc: 'selfOnly',
            allowDataUrls: false,
            allowBlobUrls: false,
            allowInlineStyles: false,
            allowEval: false,
        },
        sourceMaps: 'disabled',
        mixedContent: 'deny',
        ...overrides,
    };
}

describe('HostedPluginTarget web', () => {
    it('renders through the shared iframe engine with hosted-plugin sandbox policy', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="https://preview.example.test/plugin"
                sandbox={{
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                }}
                testID="hosted-plugin"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.src).toBe('https://preview.example.test/plugin');
        expect(iframe.props.sandbox).toBe('allow-scripts');
    });

    it('sets a frame-level CSP on the host-rendered plugin iframe (defense-in-depth)', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="https://preview.example.test/plugin"
                sandbox={{
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                }}
                security={createHostedPluginSecurityPolicy()}
                testID="hosted-plugin"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(typeof iframe.props.csp).toBe('string');
        expect(iframe.props.csp).toContain("default-src 'none'");
        expect(iframe.props.csp).toContain("script-src 'self'");
        expect(iframe.props.csp).toContain("frame-ancestors 'none'");
    });

    it('fails closed for insecure non-loopback endpoints when mixed content is denied', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="http://preview.example.test/plugin"
                sandbox={{
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                }}
                security={createHostedPluginSecurityPolicy({ mixedContent: 'deny' })}
                testID="hosted-plugin"
            />,
        );

        expect(screen.findByTestId('hosted-plugin-unavailable')).toBeTruthy();
        expect(screen.findAllByType('iframe')).toHaveLength(0);
    });

    it('clamps same-origin and top-navigation iframe privileges at the browser adapter layer', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="http://localhost:42135/plugin"
                sandbox={{
                    scripts: true,
                    sameOrigin: true,
                    popups: false,
                    topNavigation: true,
                    mixedContent: true,
                }}
                security={createHostedPluginSecurityPolicy({ mixedContent: 'devLoopbackOnly' })}
                testID="hosted-plugin"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.src).toBe('http://localhost:42135/plugin');
        expect(iframe.props.sandbox).toBe('allow-scripts');
        expect(iframe.props.referrerPolicy).toBe('no-referrer');
    });

    it('forwards only hosted-plugin bridge messages that match origin, nonce, and descriptor binding', async () => {
        const onMessage = vi.fn<(envelope: PluginHostedWebBridgeEnvelopeV1) => void>();
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const otherSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = {
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
            await renderScreen(
                <HostedPluginTarget
                    title="Hosted plugin"
                    url="https://preview.example.test/plugin"
                    sandbox={{
                        scripts: true,
                        sameOrigin: false,
                        popups: false,
                        topNavigation: false,
                        mixedContent: false,
                    }}
                    testID="hosted-plugin"
                    bridge={{
                        expectedOrigin: 'https://preview.example.test',
                        expectedPluginId: 'plugin.example',
                        expectedContributionId: 'hosted-web',
                        expectedSurfaceId: 'surface-1',
                        expectedNonce: 'nonce-1',
                        expectedSessionId: 'session-1',
                        allowedMessageKinds: new Set(['ready']),
                        onMessage,
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
                (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent({
                    origin: 'https://evil.example.test',
                    data: {
                        version: 1,
                        pluginId: 'plugin.example',
                        contributionId: 'hosted-web',
                        surfaceId: 'surface-1',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
                (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent({
                    origin: 'https://preview.example.test',
                    data: {
                        version: 1,
                        pluginId: 'plugin.example',
                        contributionId: 'hosted-web',
                        surfaceId: 'surface-1',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: otherSource,
                } as MessageEvent);
                (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent({
                    origin: 'https://preview.example.test',
                    data: {
                        version: 1,
                        pluginId: 'plugin.example',
                        contributionId: 'hosted-web',
                        surfaceId: 'surface-1',
                        sessionId: 'session-1',
                        nonce: 'nonce-1',
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(onMessage).toHaveBeenCalledTimes(1);
            expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'ready',
                nonce: 'nonce-1',
            }));
        } finally {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    });
});
