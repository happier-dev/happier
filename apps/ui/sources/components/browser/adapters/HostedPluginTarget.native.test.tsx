import { artifactHtmlBundleFromBodyV1} from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { type PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { HostedPluginTarget } from './HostedPluginTarget.native';

let lastWebViewProps: Readonly<Record<string, unknown>> | null = null;
const nativeFrame = vi.hoisted(() => ({
    registerInlineDocument: vi.fn().mockResolvedValue({ kind: 'registered' }),
    unregisterInlineDocument: vi.fn().mockReturnValue(true),
    View: vi.fn((_props: Readonly<Record<string, unknown>>) => null),
}));
vi.mock('expo-modules-core', () => ({
    // Optional native SDK modules are absent in this renderer-only boundary.
    requireOptionalNativeModule: (_moduleName: string) => null,
    requireNativeModule: () => nativeFrame,
    requireNativeViewManager: () => nativeFrame.View,
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

vi.mock('react-native-webview', () => ({
    WebView: (props: Readonly<Record<string, unknown>>) => {
        lastWebViewProps = props;
        return React.createElement('WebView', props);
    },
}));

describe('HostedPluginTarget native', () => {
    it('loads an expanded boundary-sized bundle through the isolated token transport without a WebView HTML source', async () => {
        lastWebViewProps = null;
        nativeFrame.registerInlineDocument.mockClear();
        nativeFrame.View.mockClear();
        const html = `<main>${'valid'.repeat(420_000)}</main>`;
        const screen = await renderScreen(<HostedPluginTarget title="Inline" bundle={artifactHtmlBundleFromBodyV1(html)} testID="inline" />);
        const registered = nativeFrame.registerInlineDocument.mock.calls.at(-1)?.[0];
        expect(registered?.html).toContain(html);
        expect(new TextEncoder().encode(registered?.html).length).toBeGreaterThan(2 * 1024 * 1024);
        const frameProps = nativeFrame.View.mock.calls.at(-1)?.[0];
        expect(frameProps).toMatchObject({ inlineDocumentHandleToken: registered?.token, initialPathAndQuery: '/' });
        expect(frameProps).not.toHaveProperty('html');
        expect(frameProps).not.toHaveProperty('url');
        expect(lastWebViewProps).toBeNull();
        await screen.unmount();
        expect(nativeFrame.unregisterInlineDocument).toHaveBeenCalledWith(registered?.token);
    });
    it('blocks insecure non-loopback hosted-plugin URLs before creating a native WebView', async () => {
        lastWebViewProps = null;

        const screen = await renderScreen(
            <HostedPluginTarget
                title="Hosted plugin"
                url="http://plugin.example.test/plugin"
                sandbox={{
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                }}
                security={{
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
                }}
                testID="hosted-plugin"
            />,
        );

        expect(lastWebViewProps).toBeNull();
        expect(screen.findByTestId('hosted-plugin-unavailable')).toBeTruthy();
    });

    it('does not constrain trusted plugin navigation to a declared origin allowlist', async () => {
        lastWebViewProps = null;

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
                security={{
                    allowedNavigationOrigins: [
                        'https://docs.example.test',
                        'https://preview.example.test',
                    ],
                    allowedCallbackOrigins: [
                        'https://callback.example.test',
                        'https://docs.example.test',
                    ],
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
                }}
                testID="hosted-plugin"
            />,
        );

        expect((lastWebViewProps as Readonly<{
            originWhitelist?: readonly string[];
        }> | null)?.originWhitelist).toEqual([
            '*',
        ]);
    });

    it('validates and forwards hosted-plugin bridge messages from the native WebView frame', async () => {
        const onMessage = vi.fn<(envelope: PluginHostedWebBridgeEnvelopeV1) => void>();

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
                    identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
                    allowedMessageKinds: new Set(['ready']),
                    onMessage,
                }}
            />,
        );

        expect(lastWebViewProps?.onMessage).toBeTypeOf('function');
        const dispatchMessage = lastWebViewProps?.onMessage as (event: {
            nativeEvent: {
                data: string;
                url: string;
            };
        }) => void;

        dispatchMessage({
            nativeEvent: {
                url: 'https://evil.example.test/plugin',
                data: JSON.stringify({
                    version: 1,
                    identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
                    sequence: 1,
                    kind: 'ready',
                    payload: { ready: true },
                }),
            },
        });
        dispatchMessage({
            nativeEvent: {
                url: 'https://preview.example.test/plugin',
                data: JSON.stringify({
                    version: 1,
                    identity: { instanceId: 'mount-1', mountNonce: 'wrong-nonce' },
                    sequence: 1,
                    kind: 'ready',
                    payload: { ready: true },
                }),
            },
        });
        dispatchMessage({
            nativeEvent: {
                url: 'https://preview.example.test/plugin',
                data: JSON.stringify({
                    version: 1,
                    identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
                    sequence: 1,
                    kind: 'ready',
                    payload: { ready: true },
                }),
            },
        });

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            kind: 'ready',
            identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
        }));
    });

    it('keeps a stable hook order while native hosted-plugin admission changes', async () => {
        const element = (url: string) => (
            <HostedPluginTarget
                title="Hosted plugin"
                url={url}
                sandbox={{
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                }}
                security={{
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
                }}
                testID="hosted-plugin"
            />
        );
        lastWebViewProps = null;

        const screen = await renderScreen(element('http://plugin.example.test/plugin'));
        expect(screen.findByTestId('hosted-plugin-unavailable')).toBeTruthy();

        await screen.update(element('https://preview.example.test/plugin'));
        expect(lastWebViewProps).not.toBeNull();

        await screen.update(element('http://plugin.example.test/plugin'));
        expect(screen.findByTestId('hosted-plugin-unavailable')).toBeTruthy();
    });
});
