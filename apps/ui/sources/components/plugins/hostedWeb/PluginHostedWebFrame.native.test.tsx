import * as React from 'react';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PluginHostedWebFrame } from './PluginHostedWebFrame.native';

const genericFrameProps: Array<Record<string, unknown>> = [];
const artifactFrameProps: Array<Record<string, unknown>> = [];
const inlineDocumentFrameProps: Array<Record<string, unknown>> = [];
const nativeModule = vi.hoisted(() => ({
    registerInlineDocument: vi.fn(async (_input: Readonly<{ token: string; html: string; contentSecurityPolicy: string }>) => ({ kind: 'registered' })),
    unregisterInlineDocument: vi.fn(() => true),
    goBack: vi.fn(async () => false),
}));

// The physical app-package inventory is absent in source-only host tests.
// Keep Availability declaration admission and exact Artifact source logic real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]),
}));
vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-webview', () => ({
    WebView: (props: Record<string, unknown>) => {
        genericFrameProps.push(props);
        return React.createElement('WebView', props);
    },
}));
vi.mock('expo-modules-core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return {
        ...actual,
        requireNativeModule: (name: string) => name === 'HappierHostedWebFrame'
            ? nativeModule : actual.requireNativeModule(name),
        requireNativeViewManager: (name: string) => {
            if (name !== 'HappierHostedWebFrame') throw new Error(`Unexpected native view: ${name}`);
            return React.forwardRef((props: Record<string, unknown>, _ref) => {
                if (typeof props.artifactHandleToken === 'string') artifactFrameProps.push(props);
                else inlineDocumentFrameProps.push(props);
                return React.createElement('HappierHostedWebFrame', props);
            });
        },
    };
});

const frameOrigin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('PluginHostedWebFrame native Artifact adoption', () => {
    beforeEach(() => {
        genericFrameProps.length = 0;
        artifactFrameProps.length = 0;
        inlineDocumentFrameProps.length = 0;
        nativeModule.registerInlineDocument.mockClear();
        nativeModule.unregisterInlineDocument.mockClear();
        nativeModule.goBack.mockClear();
    });
    it('forwards the shared lifecycle callbacks to the generic native URL frame', async () => {
        const onLoadStart = vi.fn();
        const onLoad = vi.fn();
        const onError = vi.fn();

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

        const frame = genericFrameProps.at(-1);
        expect(frame).toMatchObject({ source: { uri: 'https://preview.example.test/' } });
        await act(async () => {
            (frame?.onLoadStart as ((event: unknown) => void))({ nativeEvent: { url: 'https://preview.example.test/' } });
            (frame?.onLoadEnd as ((event: unknown) => void))({ nativeEvent: { url: 'https://preview.example.test/' } });
            (frame?.onError as ((event: unknown) => void))({ nativeEvent: { code: 'unreachable' } });
        });
        expect(onLoadStart).toHaveBeenCalledOnce();
        expect(onLoad).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
    });

    it('uses the opaque Artifact frame and its canonical custom-scheme bridge instead of a generic URL frame', async () => {
        const onMessage = vi.fn();

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
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }), expect.objectContaining({
            consumeTransientActivation: expect.any(Function),
        }));
    });

    it('registers by-value HTML with the incumbent isolated native frame instead of passing it to the generic WebView', async () => {
        const onMessage = vi.fn();

        const screen = await renderScreen(
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
        expect(screen.root.findAllByType('HappierHostedWebFrame')).toHaveLength(1);
        const registration = nativeModule.registerInlineDocument.mock.calls.at(-1)?.[0];
        expect(registration?.html).toContain('<p>isolated</p>');
        const inlineFrame = inlineDocumentFrameProps.at(-1);
        expect(inlineFrame).toMatchObject({
            title: 'Caller view',
            inlineDocumentHandleToken: registration?.token,
            testID: 'caller-html-frame',
        });
        expect(inlineFrame).not.toHaveProperty('bundle');
        expect(inlineFrame).not.toHaveProperty('html');
        const receive = inlineFrame?.onMessage as ((event: unknown) => void) | undefined;
        receive?.({ nativeEvent: {
            url: `happier-hosted-artifact://${registration?.token}/`,
            data: JSON.stringify({ version: 1, identity: { instanceId: 'caller-1', mountNonce: 'nonce-1' },
                sequence: 1, kind: 'ready', payload: null }),
        } });
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }), expect.objectContaining({
            consumeTransientActivation: expect.any(Function),
        }));
    });

    it('keeps the native Artifact mounted behind the shared accessible loading presentation and forwards its lifecycle callbacks', async () => {
        const onLoadStart = vi.fn();
        const onLoadEnd = vi.fn();
        const onLoadError = vi.fn();

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
        const onHistoryStateChange = vi.fn();
        const onGoBackResult = vi.fn();

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
        expect(nativeModule.goBack).toHaveBeenCalledOnce();
        (artifact?.onHistoryStateChange as ((event: unknown) => void) | undefined)?.({ nativeEvent: { canGoBack: true } });

        expect(onHistoryStateChange).toHaveBeenCalledExactlyOnceWith(true);
        expect(onGoBackResult).toHaveBeenCalledExactlyOnceWith(false);
        expect(genericFrameProps).toEqual([]);
    });
});
