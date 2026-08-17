import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const genericFrameProps: Array<Record<string, unknown>> = [];
const artifactFrameProps: Array<Record<string, unknown>> = [];

vi.mock('@/components/browser/adapters/HostedPluginTarget.native', () => ({
    HostedPluginTarget: (props: Record<string, unknown>) => {
        genericFrameProps.push(props);
        return React.createElement('HostedPluginTargetMock', props);
    },
}));
vi.mock('./HostedArtifactFrame.native', () => ({
    HostedArtifactFrame: (props: Record<string, unknown>) => {
        artifactFrameProps.push(props);
        return React.createElement('HostedArtifactFrameMock', props);
    },
}));

const frameOrigin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('PluginHostedWebFrame native Artifact adoption', () => {
    it('uses the opaque Artifact frame and its canonical custom-scheme bridge instead of a generic URL frame', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        const onMessage = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        await renderScreen(
            <PluginHostedWebFrame
                title="Preview"
                security={{
                    allowedNavigationOrigins: ['https://callback.example.test'],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    sourceMaps: 'disabled',
                    mixedContent: 'deny',
                    csp: {
                        scriptSrc: 'selfOnly', styleSrc: 'selfOnly', imgSrc: 'selfOnly', fontSrc: 'selfOnly',
                        connectSrc: 'selfOnly', allowDataUrls: false, allowBlobUrls: false,
                        allowInlineStyles: false, allowEval: false,
                    },
                }}
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                testID="plugin-hosted-web-frame"
                {...({
                    nativeArtifact: {
                        artifactHandleToken: 'hpat_frame_token',
                        initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
                    },
                    bridge: {
                        expectedOrigin: frameOrigin,
                        expectedPluginId: 'acme.preview',
                        expectedContributionId: 'preview-web',
                        expectedSurfaceId: 'preview-surface',
                        expectedNonce: 'nonce-1',
                        allowedMessageKinds: new Set(['ready']),
                        onMessage,
                    },
                } as const)}
            />,
        );

        expect(genericFrameProps).toEqual([]);
        expect(artifactFrameProps.at(-1)).toMatchObject({
            artifactHandleToken: 'hpat_frame_token',
            initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
            allowedNavigationOrigins: ['https://callback.example.test'],
            testID: 'plugin-hosted-web-frame',
        });
        expect(artifactFrameProps.at(-1)).not.toHaveProperty('url');

        const rawMessage = JSON.stringify({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'preview-surface',
            nonce: 'nonce-1',
            sequence: 1,
            kind: 'ready',
            payload: null,
        });
        const receive = artifactFrameProps.at(-1)?.onMessage as ((event: unknown) => void) | undefined;
        receive?.({ nativeEvent: { url: `${frameOrigin}/index.html`, data: rawMessage } });
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
    });

    it('keeps the native Artifact mounted behind the shared accessible loading presentation and forwards its lifecycle callbacks', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        const onLoadStart = vi.fn();
        const onLoadEnd = vi.fn();
        const onLoadError = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        const screen = await renderScreen(
            <PluginHostedWebFrame
                title="Preview"
                security={{
                    allowedNavigationOrigins: [],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    sourceMaps: 'disabled',
                    mixedContent: 'deny',
                    csp: {
                        scriptSrc: 'selfOnly', styleSrc: 'selfOnly', imgSrc: 'selfOnly', fontSrc: 'selfOnly',
                        connectSrc: 'selfOnly', allowDataUrls: false, allowBlobUrls: false,
                        allowInlineStyles: false, allowEval: false,
                    },
                }}
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                testID="plugin-hosted-web-frame"
                {...({
                    nativeArtifact: {
                        artifactHandleToken: 'hpat_frame_token',
                        initialPathAndQuery: '/',
                    },
                    nativeArtifactLoadState: 'loading',
                    onNativeArtifactLoadStart: onLoadStart,
                    onNativeArtifactLoadEnd: onLoadEnd,
                    onNativeArtifactLoadError: onLoadError,
                } as const)}
            />,
        );

        const artifact = artifactFrameProps.at(-1);
        expect(artifact).toBeDefined();
        expect(screen.findByTestId('plugin-hosted-web-frame-loading')?.props).toMatchObject({
            accessibilityLiveRegion: 'polite',
            role: 'status',
        });

        const loadStart = artifact?.onLoadStart as ((event: unknown) => void) | undefined;
        const loadEnd = artifact?.onLoadEnd as ((event: unknown) => void) | undefined;
        const loadError = artifact?.onLoadError as ((event: unknown) => void) | undefined;
        const error = { nativeEvent: { code: 'hosted_web_artifact_load_failed' } };
        loadStart?.({ nativeEvent: { url: `${frameOrigin}/` } });
        loadEnd?.({ nativeEvent: { url: `${frameOrigin}/` } });
        loadError?.(error);

        expect(onLoadStart).toHaveBeenCalledExactlyOnceWith({ nativeEvent: { url: `${frameOrigin}/` } });
        expect(onLoadEnd).toHaveBeenCalledExactlyOnceWith({ nativeEvent: { url: `${frameOrigin}/` } });
        expect(onLoadError).toHaveBeenCalledExactlyOnceWith(error);
    });

    it('forwards only an Artifact guest go-back command and its current history fact to the native Artifact frame', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        const onHistoryStateChange = vi.fn();
        const onGoBackResult = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        await renderScreen(
            <PluginHostedWebFrame
                title="Preview"
                security={{
                    allowedNavigationOrigins: [],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    sourceMaps: 'disabled',
                    mixedContent: 'deny',
                    csp: {
                        scriptSrc: 'selfOnly', styleSrc: 'selfOnly', imgSrc: 'selfOnly', fontSrc: 'selfOnly',
                        connectSrc: 'selfOnly', allowDataUrls: false, allowBlobUrls: false,
                        allowInlineStyles: false, allowEval: false,
                    },
                }}
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                testID="plugin-hosted-web-frame"
                {...({
                    nativeArtifact: {
                        artifactHandleToken: 'hpat_frame_token',
                        initialPathAndQuery: '/',
                    },
                    navigationCommand: { commandId: 'guest-back-1', kind: 'goBack' },
                    onNativeArtifactHistoryStateChange: onHistoryStateChange,
                    onNativeArtifactGoBackResult: onGoBackResult,
                } as const)}
            />,
        );

        const artifact = artifactFrameProps.at(-1);
        expect(artifact).toMatchObject({
            navigationCommand: { commandId: 'guest-back-1', kind: 'goBack' },
        });
        (artifact?.onHistoryStateChange as ((canGoBack: boolean) => void) | undefined)?.(true);
        (artifact?.onGoBackResult as ((handled: boolean) => void) | undefined)?.(false);

        expect(onHistoryStateChange).toHaveBeenCalledExactlyOnceWith(true);
        expect(onGoBackResult).toHaveBeenCalledExactlyOnceWith(false);
        expect(genericFrameProps).toEqual([]);
    });
});
