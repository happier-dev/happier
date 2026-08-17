import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeViewTestProps = Readonly<{
    artifactHandleToken: string;
    initialPathAndQuery: string;
    allowedNavigationOrigins: readonly string[];
    onMessage?: (event: unknown) => unknown;
    onLoadError?: (event: unknown) => unknown;
    onExternalNavigation?: (event: unknown) => unknown;
    onHistoryStateChange?: (event: unknown) => unknown;
    testID: string;
}>;

const nativeModuleMock = vi.hoisted(() => ({
    goBack: vi.fn(),
    postHostMessage: vi.fn(),
}));
const nativeViewMock = vi.hoisted(() => vi.fn((_props: NativeViewTestProps) => null));
const requireNativeModuleMock = vi.hoisted(() => vi.fn());
const requireNativeViewManagerMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());

vi.mock('expo-modules-core', () => ({
    requireNativeModule: requireNativeModuleMock,
    requireNativeViewManager: requireNativeViewManagerMock,
}));
vi.mock('react-native', () => ({
    Linking: { openURL: openExternalUrlMock },
}));

describe('HostedArtifactFrame native adapter', () => {
    beforeEach(() => {
        nativeModuleMock.goBack.mockReset();
        nativeModuleMock.goBack.mockResolvedValue(true);
        nativeModuleMock.postHostMessage.mockReset();
        nativeModuleMock.postHostMessage.mockResolvedValue(true);
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
            send?.({ kind: 'bootstrap', payload: { value: 'from-host' } });
            await Promise.resolve();
        });
        expect(nativeModuleMock.postHostMessage).toHaveBeenCalledWith(
            expect.anything(),
            JSON.stringify({ kind: 'bootstrap', payload: { value: 'from-host' } }),
        );

        nativeProps.onMessage?.({ nativeEvent: { data: '{"kind":"ready"}', url: 'https://opaque.plugins.happier.dev' } });
        expect(onMessage).toHaveBeenCalledWith({
            nativeEvent: { data: '{"kind":"ready"}', url: 'https://opaque.plugins.happier.dev' },
        });

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
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'preview-surface',
            nonce: 'nonce-1',
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

        expect(onMessage).toHaveBeenCalledExactlyOnceWith(event);
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
        const { isHostedArtifactFrameNativeAdapterAvailable } = await import('./HostedArtifactFrame.native');

        expect(isHostedArtifactFrameNativeAdapterAvailable()).toBe(true);

        requireNativeViewManagerMock.mockImplementation(() => {
            throw new Error('native view absent');
        });
        expect(isHostedArtifactFrameNativeAdapterAvailable()).toBe(false);
    });

    it('observes current native history and dispatches a go-back command through the Artifact module', async () => {
        const onHistoryStateChange = vi.fn();
        const { HostedArtifactFrame } = await import('./HostedArtifactFrame.native');

        await act(async () => {
            renderer.create(
                <HostedArtifactFrame
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
