import * as React from 'react';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeViewTestProps = Readonly<{
    artifactHandleToken?: string;
    inlineDocumentHandleToken?: string;
    initialPathAndQuery: string;
    allowedNavigationOrigins: readonly string[];
    onMessage?: (event: unknown) => unknown;
    onLoadError?: (event: unknown) => unknown;
    onExternalNavigation?: (event: unknown) => unknown;
    onBlockedNavigation?: (event: unknown) => unknown;
    onHistoryStateChange?: (event: unknown) => unknown;
    testID: string;
}>;

const nativeModuleMock = vi.hoisted(() => ({
    goBack: vi.fn(),
    postHostMessage: vi.fn(),
    registerInlineDocument: vi.fn(),
    unregisterInlineDocument: vi.fn(),
}));
const nativeViewMock = vi.hoisted(() => vi.fn((_props: NativeViewTestProps) => null));
const requireNativeModuleMock = vi.hoisted(() => vi.fn());
const requireNativeViewManagerMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const randomIds = vi.hoisted(() => ({
    values: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
    ],
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: requireNativeModuleMock,
    requireNativeViewManager: requireNativeViewManagerMock,
}));
vi.mock('react-native', () => ({
    Linking: { openURL: openExternalUrlMock },
    Platform: { OS: 'ios' },
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => {
        const next = randomIds.values.shift();
        if (!next) throw new Error('No test UUID remains.');
        return next;
    },
}));

describe('HostedArtifactFrame native adapter', () => {
    beforeEach(() => {
        nativeModuleMock.goBack.mockReset();
        nativeModuleMock.goBack.mockResolvedValue(true);
        nativeModuleMock.postHostMessage.mockReset();
        nativeModuleMock.postHostMessage.mockResolvedValue(true);
        nativeModuleMock.registerInlineDocument.mockReset();
        nativeModuleMock.registerInlineDocument.mockResolvedValue({ kind: 'registered' });
        nativeModuleMock.unregisterInlineDocument.mockReset();
        nativeModuleMock.unregisterInlineDocument.mockReturnValue(true);
        randomIds.values = [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444',
        ];
        openExternalUrlMock.mockReset();
        openExternalUrlMock.mockResolvedValue(true);
        nativeViewMock.mockClear();
        requireNativeModuleMock.mockReset();
        requireNativeModuleMock.mockReturnValue(nativeModuleMock);
        requireNativeViewManagerMock.mockReset();
        requireNativeViewManagerMock.mockReturnValue(nativeViewMock);
    });

    it('renders only an opaque registered token and lends the native delivery primitive while mounted', async () => {
        const attachHostMessages = vi.fn<(send: (message: unknown) => void) => () => void>();
        let send: ((message: unknown) => void) | undefined;
        const detach = vi.fn();
        attachHostMessages.mockImplementation((nextSend) => {
            send = nextSend;
            return detach;
        });
        const onMessage = vi.fn();

        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');
        let root: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            root = renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/?happierBridgeNonce=nonce_1"
                    allowedNavigationOrigins={['https://callback.example.test']}
                    attachHostMessages={attachHostMessages}
                    onMessage={onMessage}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        expect(nativeViewMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Preview',
            artifactHandleToken: 'hpat_frame_token',
            initialPathAndQuery: '/?happierBridgeNonce=nonce_1',
            allowedNavigationOrigins: ['https://callback.example.test'],
            testID: 'hosted-artifact-frame',
        }), undefined);
        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toBeDefined();
        if (!nativeProps) throw new Error('Native Artifact view did not receive props.');
        expect(nativeProps).not.toHaveProperty('url');
        expect(attachHostMessages).toHaveBeenCalledTimes(1);

        await act(async () => {
            root?.update(
                <HostedArtifactFrame
                    title="Updated preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/?happierBridgeNonce=nonce_1"
                    allowedNavigationOrigins={['https://callback.example.test']}
                    attachHostMessages={attachHostMessages}
                    onMessage={onMessage}
                    testID="hosted-artifact-frame"
                />,
            );
        });
        expect(nativeViewMock.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Updated preview' });

        await act(async () => {
            send?.({ kind: 'bootstrap', payload: { value: 'from-host' } });
            await Promise.resolve();
        });
        expect(nativeModuleMock.postHostMessage).toHaveBeenCalledWith(
            expect.anything(),
            JSON.stringify({ kind: 'bootstrap', payload: { value: 'from-host' } }),
        );

        nativeProps.onMessage?.({ nativeEvent: { data: '{"kind":"ready"}', url: 'https://opaque.plugins.happier.dev' } });
        expect(onMessage).toHaveBeenCalledWith(
            {
                nativeEvent: { data: '{"kind":"ready"}', url: 'https://opaque.plugins.happier.dev' },
            },
            expect.objectContaining({ consumeTransientActivation: expect.any(Function) }),
        );

        // Native cancels the WebView navigation. The host, not the guest
        // WebView, owns the one permitted external handoff.
        nativeProps.onExternalNavigation?.({
            nativeEvent: { url: 'https://callback.example.test/complete' },
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://callback.example.test/complete');

        await act(async () => {
            root?.unmount();
        });
        expect(detach).toHaveBeenCalledTimes(1);
    });

    it('returns a valid asynchronous bridge response to the incumbent native Artifact frame', async () => {
        const response = {
            version: 1,
            identity: { instanceId: 'preview-instance', mountNonce: 'nonce-1' },
            sequence: 2,
            requestSequence: 1,
            kind: 'ack' as const,
            payload: { accepted: true },
        };
        const malformedResponse = {
            version: 1,
            kind: 'ack',
            payload: { accepted: false },
        };
        const onMessage = vi.fn()
            .mockResolvedValueOnce(response)
            .mockResolvedValueOnce(malformedResponse);
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/?happierBridgeNonce=nonce_1"
                    allowedNavigationOrigins={[]}
                    onMessage={onMessage}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toBeDefined();
        if (!nativeProps) throw new Error('Native Artifact view did not receive props.');
        const event = {
            nativeEvent: {
                data: JSON.stringify({ kind: 'hostApi' }),
                url: 'https://opaque.plugins.happier.dev',
            },
        };
        await act(async () => {
            nativeProps.onMessage?.(event);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(onMessage).toHaveBeenCalledExactlyOnceWith(
            event,
            expect.objectContaining({ consumeTransientActivation: expect.any(Function) }),
        );
        expect(nativeModuleMock.postHostMessage).toHaveBeenCalledWith(
            expect.anything(),
            JSON.stringify(response),
        );

        await act(async () => {
            nativeProps.onMessage?.(event);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(onMessage).toHaveBeenCalledTimes(2);
        expect(nativeModuleMock.postHostMessage).toHaveBeenCalledTimes(1);
    });

    it('drops a bridge response that resolves after its native Artifact frame unmounts', async () => {
        let resolveResponse: ((response: unknown) => void) | undefined;
        const onMessage = vi.fn(() => new Promise<unknown>((resolve) => {
            resolveResponse = resolve;
        }));
        const response = {
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'preview-surface',
            nonce: 'nonce-1',
            sequence: 2,
            requestSequence: 1,
            kind: 'ack' as const,
            payload: { accepted: true },
        };
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');
        let root: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            root = renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/?happierBridgeNonce=nonce_1"
                    allowedNavigationOrigins={[]}
                    onMessage={onMessage}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toBeDefined();
        if (!nativeProps) throw new Error('Native Artifact view did not receive props.');
        nativeProps.onMessage?.({ nativeEvent: { data: JSON.stringify({ kind: 'hostApi' }) } });
        expect(onMessage).toHaveBeenCalledTimes(1);

        await act(async () => {
            root?.unmount();
        });
        await act(async () => {
            resolveResponse?.(response);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(nativeModuleMock.postHostMessage).not.toHaveBeenCalled();
    });

    it('keeps the native Artifact delivery primitive live through teardown', async () => {
        const viewPostHostMessage = vi.fn();
        const NativeView = React.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
            React.useImperativeHandle(ref, () => ({ postHostMessage: viewPostHostMessage }), []);
            return React.createElement('NativeHostedArtifactFrame', props);
        });
        requireNativeModuleMock.mockReturnValue({});
        requireNativeViewManagerMock.mockReturnValue(NativeView);
        const attachHostMessages = vi.fn<(send: (message: unknown) => void) => () => void>();
        attachHostMessages.mockImplementation((send) => () => {
            send({ kind: 'hostApi', payload: { kind: 'disconnected' } });
        });

        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');
        let root: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            root = renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/?happierBridgeNonce=nonce_1"
                    allowedNavigationOrigins={[]}
                    attachHostMessages={attachHostMessages}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        await act(async () => {
            root?.unmount();
        });

        expect(attachHostMessages).toHaveBeenCalledTimes(1);
        expect(viewPostHostMessage).toHaveBeenCalledWith(JSON.stringify({
            kind: 'hostApi',
            payload: { kind: 'disconnected' },
        }));
    });

    it('fails closed when either half of the compiled native adapter is absent', async () => {
        requireNativeModuleMock.mockImplementation(() => {
            throw new Error('native module absent');
        });
        requireNativeViewManagerMock.mockImplementation(() => {
            throw new Error('native view absent');
        });
        const onUnavailable = vi.fn();
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/"
                    allowedNavigationOrigins={[]}
                    onUnavailable={onUnavailable}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        expect(onUnavailable).toHaveBeenCalledWith('native_frame_adapter_unavailable');
        expect(nativeViewMock).not.toHaveBeenCalled();
    });

    it('routes an unavailable AndroidX profile capability through the existing native-frame fallback', async () => {
        const onLoadError = vi.fn();
        const onUnavailable = vi.fn();
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');
        await act(async () => {
            renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/"
                    allowedNavigationOrigins={[]}
                    onLoadError={onLoadError}
                    onUnavailable={onUnavailable}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toBeDefined();
        if (!nativeProps) throw new Error('Native Artifact view did not receive props.');
        const unavailable = {
            nativeEvent: {
                code: 'hosted_web_profile_isolation_unavailable',
                capability: 'MULTI_PROFILE',
            },
        };
        nativeProps.onLoadError?.(unavailable);

        expect(onLoadError).toHaveBeenCalledExactlyOnceWith(unavailable);
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('native_frame_adapter_unavailable');
    });

    it('reports the compiled native adapter only when its existing resolver finds both bridge halves', async () => {
        const {
            isHostedArtifactFrameNativeAdapterAvailable,
            isHostedInlineDocumentFrameNativeAdapterAvailable,
        } = await import('./HostedArtifactFrame.native');

        expect(isHostedArtifactFrameNativeAdapterAvailable()).toBe(true);
        expect(isHostedInlineDocumentFrameNativeAdapterAvailable()).toBe(true);

        requireNativeModuleMock.mockReturnValue({
            goBack: nativeModuleMock.goBack,
            postHostMessage: nativeModuleMock.postHostMessage,
            unregisterInlineDocument: nativeModuleMock.unregisterInlineDocument,
        });
        expect(isHostedArtifactFrameNativeAdapterAvailable()).toBe(true);
        expect(isHostedInlineDocumentFrameNativeAdapterAvailable()).toBe(false);

        requireNativeViewManagerMock.mockImplementation(() => {
            throw new Error('native view absent');
        });
        expect(isHostedArtifactFrameNativeAdapterAvailable()).toBe(false);
        expect(isHostedInlineDocumentFrameNativeAdapterAvailable()).toBe(false);
    });

    it('registers the exact built inline document and renders only its opaque current token', async () => {
        const onMessage = vi.fn();
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');
        await act(async () => {
            renderer.create(
                <HostedInlineDocumentFrame
                    title="Caller view"
                    bundle={artifactHtmlBundleFromBodyV1('<main>private</main>')}
                    networkOrigins={['https://api.example.test']}
                    bootstrapConfig={{
                        identity: { instanceId: 'inline-1', mountNonce: 'nonce-1' },
                        frameOrigin: 'null',
                        hostOrigin: 'https://app.happier.dev',
                    }}
                    allowedNavigationOrigins={[]}
                    bridge={{
                        expectedOrigin: 'null',
                        identity: { instanceId: 'inline-1', mountNonce: 'nonce-1' },
                        allowedMessageKinds: new Set(['ready']),
                        onMessage,
                    }}
                    testID="hosted-inline-document-frame"
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const token = `hpa_${'11111111111141118111111111111111'}${'22222222222242228222222222222222'}`;
        expect(nativeModuleMock.registerInlineDocument).toHaveBeenCalledExactlyOnceWith({
            token,
            html: expect.stringContaining('<main>private</main>'),
            contentSecurityPolicy: 'sandbox allow-scripts',
        });
        const registeredDocument = nativeModuleMock.registerInlineDocument.mock.calls[0]?.[0]?.html as string;
        expect(registeredDocument).toContain("connect-src https://api.example.test");
        expect(registeredDocument).toContain('"frameOrigin":"null"');
        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toMatchObject({
            inlineDocumentHandleToken: token,
            initialPathAndQuery: '/',
            testID: 'hosted-inline-document-frame',
        });
        expect(nativeProps).not.toHaveProperty('artifactHandleToken');
        expect(nativeProps).not.toHaveProperty('html');
        expect(nativeProps).not.toHaveProperty('url');

        nativeProps?.onMessage?.({
            nativeEvent: {
                url: `happier-hosted-artifact://${token}/`,
                data: JSON.stringify({
                    version: 1,
                    identity: { instanceId: 'inline-1', mountNonce: 'nonce-1' },
                    sequence: 1,
                    kind: 'ready',
                    payload: null,
                }),
            },
        });
        expect(onMessage).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'ready' }),
            expect.objectContaining({ consumeTransientActivation: expect.any(Function) }),
        );
        const receipt = onMessage.mock.calls[0]?.[1];
        expect(receipt?.consumeTransientActivation()).toBe(false);
    });

    it('fails closed with the registrar capability result and retires the denied token', async () => {
        nativeModuleMock.registerInlineDocument.mockResolvedValueOnce({
            kind: 'unavailable',
            code: 'hosted_web_profile_isolation_unavailable',
            capability: 'MULTI_PROFILE',
        });
        const onUnavailable = vi.fn();
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedInlineDocumentFrame
                    title="Caller view"
                    bundle={artifactHtmlBundleFromBodyV1('<main>private</main>')}
                    allowedNavigationOrigins={[]}
                    onUnavailable={onUnavailable}
                    testID="hosted-inline-document-frame"
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const token = nativeModuleMock.registerInlineDocument.mock.calls[0]?.[0]?.token;
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('hosted_web_profile_isolation_unavailable');
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledExactlyOnceWith(token);
        expect(nativeViewMock).not.toHaveBeenCalled();
    });

    it('synchronously retires the old inline token on replacement and the current token on unmount', async () => {
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');
        let root: renderer.ReactTestRenderer | null = null;
        const renderInline = (html: string) => (
            <HostedInlineDocumentFrame
                title="Caller view"
                bundle={artifactHtmlBundleFromBodyV1(html)}
                allowedNavigationOrigins={[]}
                testID="hosted-inline-document-frame"
            />
        );
        await act(async () => {
            root = renderer.create(renderInline('<main>G</main>'));
            await Promise.resolve();
            await Promise.resolve();
        });
        const tokenG = nativeViewMock.mock.calls.at(-1)?.[0]?.inlineDocumentHandleToken;
        expect(tokenG).toBeTruthy();

        await act(async () => {
            root?.update(renderInline('<main>H</main>'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledWith(tokenG);
        const tokenH = nativeViewMock.mock.calls.at(-1)?.[0]?.inlineDocumentHandleToken;
        expect(tokenH).toBeTruthy();
        expect(tokenH).not.toBe(tokenG);

        await act(() => {
            root?.unmount();
        });
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledWith(tokenH);
    });

    it('retires the current inline token when its native frame reports a terminal error', async () => {
        const onUnavailable = vi.fn();
        const onLoadError = vi.fn();
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedInlineDocumentFrame
                    title="Caller view"
                    bundle={artifactHtmlBundleFromBodyV1('<main>private</main>')}
                    allowedNavigationOrigins={[]}
                    onLoadError={onLoadError}
                    onUnavailable={onUnavailable}
                    testID="hosted-inline-document-frame"
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        const token = nativeProps?.inlineDocumentHandleToken;
        expect(token).toMatch(/^hpa_[0-9a-f]{64}$/);
        const error = { nativeEvent: { code: 'hosted_web_renderer_crashed' } };

        await act(async () => {
            nativeProps?.onLoadError?.(error);
        });

        expect(onLoadError).toHaveBeenCalledExactlyOnceWith(error);
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledExactlyOnceWith(token);
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('native_inline_document_load_failed');
    });

    it('retires the current inline token when native blocks an unexpected main-frame navigation', async () => {
        const onUnavailable = vi.fn();
        const onBlockedNavigation = vi.fn();
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedInlineDocumentFrame
                    title="Caller view"
                    bundle={artifactHtmlBundleFromBodyV1('<main>private</main>')}
                    allowedNavigationOrigins={[]}
                    onBlockedNavigation={onBlockedNavigation}
                    onUnavailable={onUnavailable}
                    testID="hosted-inline-document-frame"
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        const token = nativeProps?.inlineDocumentHandleToken;
        expect(token).toMatch(/^hpa_[0-9a-f]{64}$/);
        const blocked = { nativeEvent: { url: 'https://undeclared.example.test/' } };

        await act(async () => {
            nativeProps?.onBlockedNavigation?.(blocked);
        });

        expect(onBlockedNavigation).toHaveBeenCalledExactlyOnceWith(blocked);
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledExactlyOnceWith(token);
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith('native_inline_document_load_failed');
    });

    it('never mounts a stale inline registration that resolves after its generation was replaced', async () => {
        let resolveG: ((value: unknown) => void) | undefined;
        nativeModuleMock.registerInlineDocument
            .mockImplementationOnce(() => new Promise((resolve) => { resolveG = resolve; }))
            .mockResolvedValueOnce({ kind: 'registered' });
        const { HostedInlineDocumentFrame } = await import('./HostedArtifactFrame.native');
        let root: renderer.ReactTestRenderer | null = null;
        const renderInline = (html: string) => (
            <HostedInlineDocumentFrame title="Caller view" bundle={artifactHtmlBundleFromBodyV1(html)} allowedNavigationOrigins={[]} testID="inline" />
        );
        await act(async () => {
            root = renderer.create(renderInline('<main>G</main>'));
        });
        const tokenG = nativeModuleMock.registerInlineDocument.mock.calls[0]?.[0]?.token as string;
        expect(tokenG).toMatch(/^hpa_[0-9a-f]{64}$/);
        await act(async () => {
            root?.update(renderInline('<main>H</main>'));
            await Promise.resolve();
            await Promise.resolve();
        });
        const tokenH = nativeViewMock.mock.calls.at(-1)?.[0]?.inlineDocumentHandleToken;
        expect(tokenH).not.toBe(tokenG);

        await act(async () => {
            resolveG?.({ kind: 'registered' });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(nativeModuleMock.unregisterInlineDocument).toHaveBeenCalledWith(tokenG);
        expect(nativeViewMock.mock.calls.some(([props]) => (
            typeof props.inlineDocumentHandleToken === 'string'
            && props.inlineDocumentHandleToken === tokenG
        ))).toBe(false);
    });

    it('observes current native history and dispatches a go-back command through the Artifact module', async () => {
        const onHistoryStateChange = vi.fn();
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedArtifactFrame
                    title="Preview"
                    artifactHandleToken="hpat_frame_token"
                    initialPathAndQuery="/"
                    allowedNavigationOrigins={[]}
                    {...({
                        navigationCommand: { commandId: 'guest-history-back-1', kind: 'goBack' },
                        onHistoryStateChange,
                    } as const)}
                    testID="hosted-artifact-frame"
                />,
            );
        });

        const nativeProps = nativeViewMock.mock.calls.at(-1)?.[0];
        expect(nativeProps).toBeDefined();
        if (!nativeProps) throw new Error('Native Artifact view did not receive props.');
        nativeProps.onHistoryStateChange?.({ nativeEvent: { canGoBack: true } });

        expect(onHistoryStateChange).toHaveBeenCalledExactlyOnceWith(true);
        expect(nativeModuleMock.goBack).toHaveBeenCalledExactlyOnceWith(expect.anything());
    });
});
