import * as React from 'react';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const genericFrameProps: Array<Record<string, unknown>> = [];
const artifactFrameProps: Array<Record<string, unknown>> = [];
const inlineDocumentFrameProps: Array<Record<string, unknown>> = [];

// The remote source mirror intentionally omits build-generated app artifact bytes.
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(() => null),
    createPluginAccountAvailabilityReaderStore: vi.fn(() => ({
        get: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
    })),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(() => null),
}));

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
    HostedInlineDocumentFrame: (props: Record<string, unknown>) => {
        inlineDocumentFrameProps.push(props);
        return React.createElement('HostedInlineDocumentFrameMock', props);
    },
}));

const frameOrigin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('PluginHostedWebFrame native Artifact adoption', () => {
    it('forwards the shared lifecycle callbacks to the generic native URL frame', async () => {
        genericFrameProps.length = 0;
        const onLoadStart = vi.fn();
        const onLoad = vi.fn();
        const onError = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        await renderScreen(
            <PluginHostedWebFrame
                title="Preview"
                url="https://preview.example.test/"
                security={{
                    allowedNavigationOrigins: [], allowedCallbackOrigins: [], allowedConnectOrigins: [],
                    sourceMaps: 'disabled', mixedContent: 'deny',
                    csp: {
                        connectSrc: 'selfOnly', allowDataUrls: false, allowBlobUrls: false,
                        allowInlineStyles: false, allowEval: false,
                    },
                }}
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                testID="plugin-hosted-web-frame"
                onLoadStart={onLoadStart}
                onLoad={onLoad}
                onError={onError}
            />,
        );

        expect(genericFrameProps.at(-1)).toMatchObject({ onLoadStart, onLoad, onError });
    });

    it('uses the opaque Artifact frame and its canonical custom-scheme bridge instead of a generic URL frame', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        inlineDocumentFrameProps.length = 0;
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
                        identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
                        allowedMessageKinds: new Set(['ready']),
                        onMessage,
                    },
                } as const)}
            />,
        );

        expect(genericFrameProps).toEqual([]);
        expect(inlineDocumentFrameProps).toEqual([]);
        expect(artifactFrameProps.at(-1)).toMatchObject({
            title: 'Preview',
            artifactHandleToken: 'hpat_frame_token',
            initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
            allowedNavigationOrigins: ['https://callback.example.test'],
            testID: 'plugin-hosted-web-frame',
        });
        expect(artifactFrameProps.at(-1)).not.toHaveProperty('url');

        const rawMessage = JSON.stringify({
            version: 1,
            identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
            sequence: 1,
            kind: 'ready',
            payload: null,
        });
        const receive = artifactFrameProps.at(-1)?.onMessage as ((event: unknown) => void) | undefined;
        receive?.({ nativeEvent: { url: `${frameOrigin}/index.html`, data: rawMessage } });
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }), undefined);
    });

    it('registers by-value HTML with the incumbent isolated native frame instead of passing it to the generic WebView', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        inlineDocumentFrameProps.length = 0;
        const onMessage = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        await renderScreen(
            <PluginHostedWebFrame
                title="Caller view"
                bundle={artifactHtmlBundleFromBodyV1('<!doctype html><p>isolated</p>')}
                security={{
                    allowedNavigationOrigins: [],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    sourceMaps: 'disabled',
                    mixedContent: 'deny',
                    csp: {
                        connectSrc: 'none', allowDataUrls: true, allowBlobUrls: false,
                        allowInlineStyles: true, allowEval: false,
                    },
                }}
                sandbox={{ scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false }}
                testID="caller-html-frame"
                bridge={{
                    expectedOrigin: 'null',
                    identity: { instanceId: 'caller-1', mountNonce: 'nonce-1' },
                    allowedMessageKinds: new Set(['ready']),
                    onMessage,
                }}
            />,
        );

        expect(artifactFrameProps).toEqual([]);
        expect(genericFrameProps).toEqual([]);
        expect(inlineDocumentFrameProps).toHaveLength(1);
        expect(inlineDocumentFrameProps[0]).toMatchObject({
            title: 'Caller view',
            bundle: artifactHtmlBundleFromBodyV1('<!doctype html><p>isolated</p>'),
            testID: 'caller-html-frame',
            networkOrigins: undefined,
            bootstrapConfig: undefined,
        });
        expect(inlineDocumentFrameProps[0]?.bridge).toEqual(expect.objectContaining({
            identity: { instanceId: 'caller-1', mountNonce: 'nonce-1' },
        }));
    });

    it('keeps the native Artifact mounted behind the shared accessible loading presentation and forwards its lifecycle callbacks', async () => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        const onLoadStart = vi.fn();
        const onLoadEnd = vi.fn();
        const onLoadError = vi.fn();
        const { PluginHostedWebFrame } = await import('./PluginHostedWebFrame.native');

        const renderArtifactFrame = (nativeArtifactLoadState: 'loading' | 'ready') => (
            <PluginHostedWebFrame
                title="Preview"
                security={{
                    allowedNavigationOrigins: [],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    sourceMaps: 'disabled',
                    mixedContent: 'deny',
                    csp: {
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
                    nativeArtifactLoadState,
                    onNativeArtifactLoadStart: onLoadStart,
                    onNativeArtifactLoadEnd: onLoadEnd,
                    onNativeArtifactLoadError: onLoadError,
                } as const)}
            />
        );
        const screen = await renderScreen(renderArtifactFrame('loading'));

        const artifact = artifactFrameProps.at(-1);
        expect(artifact).toBeDefined();
        expect(artifact?.title).toBe('Preview');
        const loadingFrame = screen.findAll((node) => node.props.accessibilityElementsHidden !== undefined).at(-1);
        expect(loadingFrame?.props).toMatchObject({
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(loadingFrame?.props.accessible).toBeUndefined();
        expect(loadingFrame?.props.accessibilityLabel).toBeUndefined();
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

        await screen.update(renderArtifactFrame('ready'));
        const readyFrame = screen.findAll((node) => node.props.accessibilityElementsHidden !== undefined).at(-1);
        expect(readyFrame?.props).toMatchObject({
            accessibilityElementsHidden: false,
            importantForAccessibility: 'auto',
        });
        expect(readyFrame?.props.accessible).toBeUndefined();
        expect(readyFrame?.props.accessibilityLabel).toBeUndefined();
        expect(artifactFrameProps.at(-1)?.title).toBe('Preview');
        expect(screen.findByTestId('plugin-hosted-web-frame-loading')).toBeNull();
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
