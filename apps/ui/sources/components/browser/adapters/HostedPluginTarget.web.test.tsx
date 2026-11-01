import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { HostedPluginTarget } from './HostedPluginTarget.web';
import { WebIframeEngine } from '../frame/engines/WebIframeEngine';

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
    it('retains prepared document bytes across equivalent inputs and replaces real bootstrap, policy, and body changes', async () => {
        // Resolve the real lazy guest bootstrap before the render-readiness assertion;
        // source transformation belongs to the test setup, not a guest deadline.
        await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
        const render = (nonce: string, origin: string, body: string) => (
            <HostedPluginTarget
                title="Inline plugin"
                bundle={artifactHtmlBundleFromBodyV1(body)}
                bootstrapConfig={{
                    identity: { instanceId: 'inline-instance', mountNonce: nonce },
                    frameOrigin: 'null',
                    hostOrigin: 'https://host.happier.test',
                }}
                networkOrigins={[origin]}
                testID="inline-plugin"
            />
        );
        const screen = await renderScreen(render('nonce-a', 'https://api.example.test', '<p>Original</p>'));
        await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
        const iframe = screen.findByType(WebIframeEngine);
        const originalDocument = iframe.props.html;

        // Callers legitimately reconstruct immutable graphs during host renders.
        // Equal facts keep the same prepared source and transport container.
        await screen.update(render('nonce-a', 'https://api.example.test', '<p>Original</p>'));
        expect(Object.is(screen.findByType(WebIframeEngine), iframe)).toBe(true);
        expect(screen.findByType(WebIframeEngine).props.html).toBe(originalDocument);

        await screen.update(render('nonce-b', 'https://api.example.test', '<p>Original</p>'));
        await vi.waitFor(() => {
            const document = String(screen.findByType(WebIframeEngine).props.html);
            expect(document).toContain('nonce-b');
            expect(document).not.toContain('nonce-a');
        });

        await screen.update(render('nonce-b', 'https://other.example.test', '<p>Original</p>'));
        await vi.waitFor(() => {
            const document = String(screen.findByType(WebIframeEngine).props.html);
            expect(document).toContain('connect-src data: https://other.example.test');
            expect(document).not.toContain('https://api.example.test');
        });

        await screen.update(render('nonce-b', 'https://other.example.test', '<p>Replacement</p>'));
        await vi.waitFor(() => {
            const document = String(screen.findByType(WebIframeEngine).props.html);
            expect(document).toContain('nonce-b');
            expect(document).not.toContain('nonce-a');
            expect(document).toContain('connect-src data: https://other.example.test');
            expect(document).not.toContain('https://api.example.test');
            expect(document).toContain('<p>Replacement</p>');
            expect(document).not.toContain('<p>Original</p>');
        });
    });

    it('keeps authored content out of the trusted navigation shell', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                title="Inline plugin"
                bundle={artifactHtmlBundleFromBodyV1('<!doctype html><button>Inline</button>')}
                testID="inline-plugin"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.srcDoc).not.toContain('<button>Inline</button>');
        expect(iframe.props.srcDoc).toContain("frame-src 'none'");
        expect(iframe.props.src).toBeUndefined();
        expect(screen.findByType(WebIframeEngine).props.sandbox).toBe('allow-scripts');
    });

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
        // EU-8: `allow-same-origin` is the transport's requirement, not an
        // author capability — without it the guest's origin is opaque and the
        // bridge cannot validate or address a single message.
        expect(iframe.props.sandbox).toBe('allow-scripts allow-same-origin');
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
        // No readable host document origin in this environment, so the ancestor
        // fails closed rather than being widened.
        expect(iframe.props.csp).toContain("frame-ancestors 'none'");
    });

    it('uses the canonical route CSP only for opaque Artifact frames while generic URL frames retain host iframe CSP', async () => {
        const genericScreen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="https://preview.example.test/plugin"
                security={createHostedPluginSecurityPolicy()}
                testID="generic-hosted-plugin"
            />,
        );
        expect(typeof genericScreen.findByType('iframe').props.csp).toBe('string');

        const artifactScreen = await renderScreen(
            <HostedPluginTarget
                title="Hosted artifact"
                url="https://host.happier.test/__happier/hosted-artifacts/token/index.html"
                security={createHostedPluginSecurityPolicy()}
                testID="opaque-hosted-artifact"
                opaqueArtifactFrame
            />,
        );
        expect(artifactScreen.findByType('iframe').props.csp).toBeUndefined();
    });

    it('names THIS document as the frame ancestor when its origin is readable (EU-8)', async () => {
        // The unconditional `'none'` this replaces made the frame-level policy
        // contradict the served response header and refuse the very frame
        // Happier renders. The ancestor is the embedding document, never the
        // author's declared origins.
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        try {
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
                    security={createHostedPluginSecurityPolicy({
                        allowedNavigationOrigins: ['https://author.example.test'],
                    })}
                    testID="hosted-plugin"
                />,
            );

            const iframe = screen.findByType('iframe');
            expect(iframe.props.csp).toContain('frame-ancestors https://host.happier.test');
            expect(iframe.props.csp).not.toContain('frame-ancestors https://author.example.test');
        } finally {
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
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
        // The clamp that matters is still enforced — an author asking for top
        // navigation without a declared navigation/callback origin does not get
        // it, and popups stay off. The daemon's own loopback origin DOES get
        // `allow-same-origin`, because the bridge cannot address an opaque
        // origin in either direction (EU-8, proven in Chromium).
        expect(iframe.props.sandbox).toBe('allow-scripts allow-same-origin');
        expect(iframe.props.sandbox).not.toContain('allow-top-navigation');
        expect(iframe.props.sandbox).not.toContain('allow-popups');
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
                        identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
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
                        identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
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
                        identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
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
                        identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(onMessage).toHaveBeenCalledTimes(1);
            expect(onMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
                kind: 'ready',
                identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            }));
        } finally {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    });

    it('does not grant a copied opaque Artifact URL bridge authority without the mounted contentWindow', async () => {
        const onMessage = vi.fn<(envelope: PluginHostedWebBridgeEnvelopeV1) => void>();
        const listeners = new Set<(event: MessageEvent) => void>();
        const mountedSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const copiedCapabilitySource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const documentPort = {
            onmessage: null as ((event: Readonly<{ data: unknown }>) => void) | null,
            postMessage: vi.fn(),
            start: vi.fn(),
            close: vi.fn(),
        } as unknown as MessagePort;
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
        const ready = {
            version: 1,
            identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        } as const;

        try {
            await renderScreen(
                <HostedPluginTarget
                    title="Hosted artifact"
                    url="https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/"
                    security={createHostedPluginSecurityPolicy()}
                    testID="hosted-plugin"
                    opaqueArtifactFrame
                    bridge={{
                        expectedOrigin: 'https://artifacts.happier.test',
                        identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
                        allowedMessageKinds: new Set(['ready']),
                        onMessage,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: mountedSource }
                            : null
                    ),
                },
            );

            await act(async () => {
                const copiedCapabilityEvent = new MessageEvent('message', {
                    origin: 'null',
                    data: ready,
                });
                Object.defineProperty(copiedCapabilityEvent, 'source', {
                    value: copiedCapabilitySource,
                });
                (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent(
                    copiedCapabilityEvent,
                );
                const mountedEvent = new MessageEvent('message', {
                    origin: 'null',
                    data: ready,
                });
                Object.defineProperties(mountedEvent, {
                    source: { value: mountedSource },
                    ports: { value: [documentPort] },
                });
                (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent(
                    mountedEvent,
                );
            });

            expect(onMessage).toHaveBeenCalledTimes(1);
            expect(onMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
                identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
                kind: 'ready',
            }));
        } finally {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    });

    it('keeps an Artifact-backed frame opaque and unloads it after an unexpected self-navigation', async () => {
        const screen = await renderScreen(
            <HostedPluginTarget
                {...({
                    title: 'Hosted artifact',
                    url: 'https://host.happier.test/__happier/hosted-artifacts/token/index.html',
                    sandbox: {
                        scripts: true,
                        sameOrigin: true,
                        popups: false,
                        topNavigation: true,
                        mixedContent: false,
                    },
                    security: createHostedPluginSecurityPolicy({
                        allowedNavigationOrigins: ['https://docs.example.test'],
                    }),
                    testID: 'hosted-plugin',
                    opaqueArtifactFrame: true,
                } as React.ComponentProps<typeof HostedPluginTarget> & Readonly<{
                    opaqueArtifactFrame: true;
                }>)}
            />,
        );

        const initial = screen.findByType('iframe');
        expect(initial.props.sandbox).toBe('allow-scripts');

        await act(async () => {
            initial.props.onLoad?.();
            await Promise.resolve();
        });
        expect(screen.findAllByType('iframe')).toHaveLength(1);

        await act(async () => {
            screen.findByType('iframe').props.onLoad?.();
            await Promise.resolve();
        });
        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(screen.findByTestId('hosted-plugin-unavailable')).toBeTruthy();
    });
});
