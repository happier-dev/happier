import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebAccountDataBridgeOperationV1,
    PluginHostedWebAccountDataBridgeResponseV1,
    PluginUiHostApiWireIdentityV1,
    PluginUiLaunchInputV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import type { PluginUiArtifactAdoption } from '@/sync/domains/plugins/ui/artifactAdoption';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frameProps: Array<Record<string, unknown>> = [];
const hostMessages: unknown[] = [];
let attachmentTeardownCount = 0;
let frameMountCount = 0;
let frameUnmountCount = 0;

type HardwareBackHandler = () => boolean | null | undefined;

const nativeBack = vi.hoisted(() => {
    let handlers: HardwareBackHandler[] = [];

    const addEventListener = vi.fn((eventName: string, handler: HardwareBackHandler) => {
        if (eventName !== 'hardwareBackPress') {
            throw new Error(`Unexpected native BackHandler event: ${eventName}`);
        }
        handlers = [...handlers, handler];
        return {
            remove: () => {
                handlers = handlers.filter((candidate) => candidate !== handler);
            },
        };
    });

    return {
        addEventListener,
        emit() {
            for (const handler of [...handlers].reverse()) {
                if (handler()) return true;
            }
            return false;
        },
        reset() {
            handlers = [];
            addEventListener.mockClear();
        },
    };
});

const nativeRouteBack = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: Readonly<{ data: Readonly<{ action: unknown }> }>) => void),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: (props: any) => React.createElement('View', props, props.children),
        BackHandler: {
            addEventListener: nativeBack.addEventListener,
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@react-navigation/native', async () => {
    const actual = await vi.importActual<typeof import('@react-navigation/native')>('@react-navigation/native');
    const NavigationContext = React.createContext<Readonly<{ dispatch: (action: unknown) => void }> | null>(null);
    return {
        ...actual,
        NavigationContext,
        usePreventRemove: (
            enabled: boolean,
            callback: (event: Readonly<{ data: Readonly<{ action: unknown }> }>) => void,
        ) => {
            nativeRouteBack.enabled = enabled;
            nativeRouteBack.callback = callback;
            React.useEffect(() => () => {
                if (nativeRouteBack.callback === callback) {
                    nativeRouteBack.enabled = false;
                    nativeRouteBack.callback = null;
                }
            }, [callback]);
        },
    };
});
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('./PluginHostedWebFrame', () => ({
    PluginHostedWebFrame: (props: Record<string, unknown>) => {
        frameProps.push(props);
        const bridge = props.bridge as Readonly<{
            attachHostMessages?: (send: (message: unknown) => void) => () => void;
        }> | null;
        React.useLayoutEffect(() => {
            if (!bridge?.attachHostMessages) return;
            const detach = bridge.attachHostMessages((message) => {
                hostMessages.push(message);
            });
            return () => {
                attachmentTeardownCount += 1;
                detach();
            };
        }, [bridge]);
        React.useLayoutEffect(() => {
            frameMountCount += 1;
            return () => {
                frameUnmountCount += 1;
            };
        }, []);
        return React.createElement('PluginHostedWebFrameMock', { testID: props.testID });
    },
}));

const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalMount = {
    kind: 'destination',
    destination: { pluginId: 'acme.preview', localId: 'preview-web' },
    container: 'rightPane',
} satisfies SurfaceContext['mount'];

const canonicalTargetedContributions = {
    target: {
        pluginId: 'acme.target',
        immutableGenerationId: 'target-generation-1',
    },
    points: [],
} satisfies SurfaceContext['targetedContributions'];

const projection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        'acme.preview': {
            id: 'translations:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'translations',
            locales: ['en'],
            bundles: { en: { 'preview.frame.title': 'Preview panel' } },
        },
    },
    hostedWebById: {
        'hostedWeb:acme.preview:preview-web': {
            id: 'hostedWeb:acme.preview:preview-web',
            pluginId: 'acme.preview',
            contributionKind: 'hostedWeb',
            contributionId: 'preview-web',
            display: { titleKey: 'preview.frame.title', developerFallback: 'Preview' },
            service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'fallback',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                decision: {
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                    diagnostics: ['hosted_web_frame_adapter_unavailable'],
                },
            },
        },
    },
};

function createHandle(input: Readonly<{ frameOrigin?: string }> = {}) {
    let current = true;
    const revokeListeners = new Set<() => void>();
    // The canonical native Artifact handle's `dispose` IS its registration
    // revoke: after it runs the token is tombstoned and `isCurrent()` is false.
    const dispose = vi.fn(() => {
        if (!current) return;
        current = false;
        for (const listener of [...revokeListeners]) listener();
    });
    return {
        handle: {
            token: 'hpat_frame_token',
            storagePartitionId: `hpa_${'a'.repeat(64)}`,
            policyTable: { version: 1, routes: [] } as const,
            isCurrent: vi.fn(() => current),
            onRevoke: vi.fn((listener: () => void) => {
                revokeListeners.add(listener);
                return { dispose: () => revokeListeners.delete(listener) };
            }),
            dispose,
            ...(input.frameOrigin === undefined ? {} : { frameOrigin: input.frameOrigin }),
        },
        dispose,
        revoke: () => {
            current = false;
            for (const listener of [...revokeListeners]) listener();
        },
    };
}

function createNativeArtifactAdoption(
    handle: PluginNativeArtifactResourceHandle,
): PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle> {
    let disposed = false;
    return Object.freeze({
        kind: 'hostedWebNative' as const,
        handle,
        isCurrent: handle.isCurrent,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            handle.dispose();
        },
    });
}

function findBridge(): Readonly<{
    onMessage: (envelope: PluginHostedWebBridgeEnvelopeV1) => unknown;
}> {
    const bridge = [...frameProps].reverse().find((props) => props.bridge)?.bridge;
    if (!bridge || typeof (bridge as Readonly<{ onMessage?: unknown }>).onMessage !== 'function') {
        throw new Error('Expected a mounted hosted Artifact bridge.');
    }
    return bridge as Readonly<{
        onMessage: (envelope: PluginHostedWebBridgeEnvelopeV1) => unknown;
    }>;
}

function createBridgeEnvelope(input: Readonly<{
    surface: PluginUiSurfaceContextV1;
    nonce: string;
    sequence: number;
    kind: PluginHostedWebBridgeEnvelopeV1['kind'];
    payload: PluginHostedWebBridgeEnvelopeV1['payload'];
}>): PluginHostedWebBridgeEnvelopeV1 {
    return {
        version: 1,
        pluginId: input.surface.pluginId,
        contributionId: input.surface.contributionId,
        surfaceId: input.surface.surfaceId,
        ...(input.surface.sessionId === undefined ? {} : { sessionId: input.surface.sessionId }),
        nonce: input.nonce,
        sequence: input.sequence,
        kind: input.kind,
        payload: input.payload,
    } as PluginHostedWebBridgeEnvelopeV1;
}

describe('PluginHostedWebPane native Artifact consumer', () => {
    beforeEach(() => {
        nativeRouteBack.enabled = false;
        nativeRouteBack.callback = null;
        nativeBack.reset();
    });
    it('publishes only the exact current ready Artifact identity as a non-accessible native diagnostic', async () => {
        frameProps.length = 0;
        const first = createHandle();
        const second = createHandle();
        const artifactDigest: `sha256:${string}` = `sha256:${'b'.repeat(64)}`;
        const readyDiagnosticTestId = [
            'plugin-hosted-web-native-ready',
            'acme.preview',
            'preview-web',
            '27',
            artifactDigest,
        ].join(':');
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const identity = {
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            projectionGeneration: 27,
            artifactDigest,
        } as const;
        const element = (
            nativeArtifactAdoption: PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle>,
            mountInstanceKey: string,
        ) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce={`diagnostic-${mountInstanceKey}`}
                projectionGeneration={27}
                {...({
                    nativeArtifactAdoption,
                    nativeArtifactLoadedRuntimeIdentity: identity,
                    mountInstanceKey,
                } as const)}
            />
        );
        const screen = await renderScreen(element(createNativeArtifactAdoption(first.handle), 'first'));

        expect(screen.findByTestId(readyDiagnosticTestId)).toBeNull();
        const staleLoadEnd = frameProps.at(-1)?.onNativeArtifactLoadEnd as (() => void) | undefined;

        await screen.update(element(createNativeArtifactAdoption(second.handle), 'second'));
        await act(async () => {
            staleLoadEnd?.();
        });
        expect(screen.findByTestId(readyDiagnosticTestId)).toBeNull();

        const currentLoadEnd = frameProps.at(-1)?.onNativeArtifactLoadEnd as (() => void) | undefined;
        await act(async () => {
            currentLoadEnd?.();
        });

        const diagnostic = screen.findByTestId(readyDiagnosticTestId);
        expect(diagnostic).toBeTruthy();
        expect(diagnostic?.props).toEqual(expect.objectContaining({
            accessible: false,
            collapsable: false,
        }));
        expect(diagnostic?.props.accessibilityElementsHidden).toBeUndefined();
        expect(diagnostic?.props.importantForAccessibility).toBeUndefined();
        expect(readyDiagnosticTestId).not.toContain('hpat_frame_token');
        expect(readyDiagnosticTestId).not.toContain(`hpa_${'a'.repeat(64)}`);
        expect(frameProps.at(-1)?.onNativeArtifactHistoryStateChange).toEqual(expect.any(Function));
        expect(frameProps.at(-1)?.onNativeArtifactGoBackResult).toEqual(expect.any(Function));

        await act(async () => {
            second.revoke();
            await Promise.resolve();
        });
        expect(screen.findByTestId(readyDiagnosticTestId)).toBeNull();
    });
    it('mounts only an injected opaque handle, keeps launch facts out of the address, and disposes it on target replacement', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, sessionId: 'session-1' }}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="nonce-1"
                {...({
                    nativeArtifactAdoption: createNativeArtifactAdoption(native.handle),
                    mountInstanceKey: 'target-one',
                    launchInput: { secret: 'not-in-url' },
                    subPath: 'not/in/url',
                } as const)}
            />,
        );

        const mounted = frameProps.at(-1);
        expect((mounted?.nativeArtifact as { artifactHandleToken?: string } | undefined)?.artifactHandleToken)
            .toBe('hpat_frame_token');
        expect((mounted?.bridge as { expectedOrigin?: string } | undefined)?.expectedOrigin)
            .toBe(`happier-hosted-artifact://hpa_${'a'.repeat(64)}`);
        expect(mounted).not.toHaveProperty('url');
        const initialPathAndQuery = (mounted?.nativeArtifact as { initialPathAndQuery: string }).initialPathAndQuery;
        expect(initialPathAndQuery).toContain('happierBridgeNonce=nonce-1');
        expect(initialPathAndQuery).not.toContain('happierSessionId');
        expect(initialPathAndQuery).not.toContain('happierLaunchInput');
        expect(initialPathAndQuery).not.toContain('happierSubPath');

        await screen.update(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="nonce-2"
                {...({ nativeArtifactAdoption: null, mountInstanceKey: 'target-two' } as const)}
            />,
        );
        expect(native.dispose).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('binds Android to its asset-loader HTTPS origin instead of the iOS custom scheme', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, platform: 'android' }}
                pluginUiProjection={projection}
                platform="android"
                bridgeNonce="nonce-android"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'target-android' } as const)}
            />,
        );

        expect((frameProps.at(-1)?.bridge as { expectedOrigin?: string } | undefined)?.expectedOrigin)
            .toBe(`https://hpa_${'a'.repeat(64)}.plugins.happier.dev`);
    });

    it('binds desktop to the direct-Wry Artifact prop and the exact custom-scheme origin', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, platform: 'desktop' }}
                pluginUiProjection={projection}
                platform="desktop"
                bridgeNonce="nonce-desktop"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'target-desktop' } as const)}
            />,
        );

        const mounted = frameProps.at(-1);
        expect((mounted?.desktopArtifact as { artifactHandleToken?: string } | undefined)?.artifactHandleToken)
            .toBe('hpat_frame_token');
        expect(mounted).not.toHaveProperty('nativeArtifact');
        expect((mounted?.bridge as { expectedOrigin?: string } | undefined)?.expectedOrigin)
            .toBe(`happier-hosted-artifact://hpa_${'a'.repeat(64)}`);
        expect(mounted).not.toHaveProperty('url');
    });

    it('uses the exact Windows Wry HTTPS origin returned by the native Artifact adapter', async () => {
        frameProps.length = 0;
        const frameOrigin = `https://happier-hosted-artifact.hpa_${'a'.repeat(64)}`;
        const native = createHandle({ frameOrigin });
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, platform: 'desktop' }}
                pluginUiProjection={projection}
                platform="desktop"
                bridgeNonce="nonce-windows-desktop"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'target-windows-desktop' } as const)}
            />,
        );

        expect((frameProps.at(-1)?.bridge as { expectedOrigin?: string } | undefined)?.expectedOrigin)
            .toBe(frameOrigin);
    });

    it('feeds desktop host history and the canonical Back command through the direct-Wry frame', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, platform: 'desktop' }}
                pluginUiProjection={projection}
                platform="desktop"
                bridgeNonce="desktop-history-nonce"
                navigationCommand={{ commandId: 'desktop-history-back-1', kind: 'goBack' }}
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'desktop-history' } as const)}
            />,
        );

        const mounted = frameProps.at(-1);
        expect(mounted?.navigationCommand).toEqual({ commandId: 'desktop-history-back-1', kind: 'goBack' });
        expect(mounted?.onNativeArtifactHistoryStateChange).toEqual(expect.any(Function));
        expect(mounted?.onNativeArtifactGoBackResult).toEqual(expect.any(Function));

        const historyStateChange = mounted?.onNativeArtifactHistoryStateChange as ((canGoBack: boolean) => void) | undefined;
        await act(async () => {
            historyStateChange?.(true);
        });
        expect(frameProps.at(-1)?.navigationCommand).toEqual({ commandId: 'desktop-history-back-1', kind: 'goBack' });
    });

    it('treats a current native Artifact as loading rather than unavailable, then lets native callbacks publish ready or error state', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="native-lifecycle-nonce"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'native-lifecycle' } as const)}
            />,
        );

        const loadingProps = frameProps.at(-1);
        expect(loadingProps?.nativeArtifactLoadState).toBe('loading');
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();

        const loadEnd = loadingProps?.onNativeArtifactLoadEnd as (() => void) | undefined;
        await act(async () => {
            loadEnd?.();
        });
        expect(frameProps.at(-1)?.nativeArtifactLoadState).toBe('ready');

        expect(native.dispose).not.toHaveBeenCalled();

        const loadError = frameProps.at(-1)?.onNativeArtifactLoadError as ((event: unknown) => void) | undefined;
        await act(async () => {
            loadError?.({ nativeEvent: { code: 'hosted_web_artifact_load_failed' } });
        });
        // The failed mount is retired synchronously with the transition off it,
        // so no late guest/bridge work can settle through the dead frame.
        expect(native.dispose).toHaveBeenCalled();
        expect(native.handle.isCurrent()).toBe(false);
        expect(screen.findByTestId('plugin-hosted-web-frame-error')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame-error-diagnostic-hosted_web_artifact_load_failed')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
    });

    it('intercepts iOS route Back only for current guest history, then releases the route when native history declines', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const dispatch = vi.fn();
        const { NavigationContext } = await import('@react-navigation/native');
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        // The route guard consumes only the real navigator's dispatch method.
        // This fixture deliberately supplies that boundary method and nothing
        // from the unrelated navigator implementation.
        const navigation = { dispatch } as unknown as React.ContextType<typeof NavigationContext>;
        const firstScreen = await renderScreen(
            <NavigationContext.Provider value={navigation}>
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    platform="ios"
                    interactionEnabled
                    bridgeNonce="native-history-route-nonce"
                    {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'native-history-route' } as const)}
                />
            </NavigationContext.Provider>,
        );

        const historyStateChange = frameProps.at(-1)?.onNativeArtifactHistoryStateChange as ((canGoBack: boolean) => void) | undefined;
        await act(async () => {
            historyStateChange?.(true);
        });
        expect(nativeRouteBack.enabled).toBe(true);

        const blockedAction = { type: 'GO_BACK' };
        await act(async () => {
            nativeRouteBack.callback?.({ data: { action: blockedAction } });
        });
        expect(frameProps.at(-1)?.navigationCommand).toEqual(expect.objectContaining({ kind: 'goBack' }));
        expect(dispatch).not.toHaveBeenCalled();

        const goBackResult = frameProps.at(-1)?.onNativeArtifactGoBackResult as ((handled: boolean) => void) | undefined;
        await act(async () => {
            goBackResult?.(false);
        });
        expect(nativeRouteBack.enabled).toBe(false);
        await firstScreen.unmount();

        // A native refusal is not a new route owner. The already-enabled guard
        // also redispatches immediately if the handle ceases to be current.
        const second = createHandle();
        const screen = await renderScreen(
            <NavigationContext.Provider value={navigation}>
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    platform="ios"
                    interactionEnabled
                    bridgeNonce="native-history-route-fallthrough-nonce"
                    {...({ nativeArtifactAdoption: createNativeArtifactAdoption(second.handle), mountInstanceKey: 'native-history-route-fallthrough' } as const)}
                />
            </NavigationContext.Provider>,
        );
        const secondHistoryStateChange = frameProps.at(-1)?.onNativeArtifactHistoryStateChange as ((canGoBack: boolean) => void) | undefined;
        await act(async () => {
            secondHistoryStateChange?.(true);
        });
        second.handle.isCurrent.mockReturnValue(false);
        const fallthroughAction = { type: 'GO_BACK' };
        await act(async () => {
            nativeRouteBack.callback?.({ data: { action: fallthroughAction } });
        });
        expect(dispatch).toHaveBeenCalledWith(fallthroughAction);
        await screen.unmount();
    });

    it('keeps a presentation-ineligible iOS Artifact guest mounted while releasing route Back ownership', async () => {
        frameProps.length = 0;
        frameMountCount = 0;
        frameUnmountCount = 0;
        const native = createHandle();
        const nativeArtifactAdoption = createNativeArtifactAdoption(native.handle);
        const dispatch = vi.fn();
        const { NavigationContext } = await import('@react-navigation/native');
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const navigation = { dispatch } as unknown as React.ContextType<typeof NavigationContext>;
        const element = (focusEligible: boolean) => (
            <NavigationContext.Provider value={navigation}>
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    platform="ios"
                    interactionEnabled
                    {...({
                        focusEligible,
                        nativeArtifactAdoption,
                        mountInstanceKey: 'presentation-ineligible-native-history-route',
                    } as const)}
                />
            </NavigationContext.Provider>
        );
        const screen = await renderScreen(element(true));
        const historyStateChange = frameProps.at(-1)?.onNativeArtifactHistoryStateChange as ((canGoBack: boolean) => void) | undefined;
        await act(async () => {
            historyStateChange?.(true);
        });
        expect(nativeRouteBack.enabled).toBe(true);
        const initialMountCount = frameMountCount;
        const initialUnmountCount = frameUnmountCount;

        await screen.update(element(false));
        expect(nativeRouteBack.enabled).toBe(false);
        expect(frameMountCount).toBe(initialMountCount);
        expect(frameUnmountCount).toBe(initialUnmountCount);

        await screen.update(element(true));
        expect(nativeRouteBack.enabled).toBe(true);
        expect(frameMountCount).toBe(initialMountCount);
        expect(frameUnmountCount).toBe(initialUnmountCount);
        await screen.unmount();
    });

    it('lets the modal host close an inert Android Artifact guest instead of lending it hardware Back', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const onRequestClose = vi.fn();
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        const { ModalPaneBoundaryView, useModalPaneBoundary } = await import('@/components/ui/panels/ModalPaneBoundary');
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

        function PaneBoundary() {
            const boundary = useModalPaneBoundary({
                active: true,
                label: 'Hosted plugin pane',
                onRequestClose,
            });
            return (
                <ModalPaneBoundaryView {...boundary.overlayProps}>
                    <PluginHostedWebPane
                        contributionId="hostedWeb:acme.preview:preview-web"
                        surfaceContext={{ ...surfaceContext, platform: 'android' }}
                        pluginUiProjection={projection}
                        platform="android"
                        interactionEnabled
                        {...({
                            focusEligible: false,
                            nativeArtifactAdoption: createNativeArtifactAdoption(native.handle),
                            mountInstanceKey: 'inert-android-history',
                        } as const)}
                    />
                </ModalPaneBoundaryView>
            );
        }

        Platform.OS = 'android';
        try {
            screen = await renderScreen(<PaneBoundary />);
            const historyStateChange = frameProps.at(-1)?.onNativeArtifactHistoryStateChange as ((canGoBack: boolean) => void) | undefined;
            await act(async () => {
                historyStateChange?.(true);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            let consumed = false;
            await act(async () => {
                consumed = nativeBack.emit();
            });
            expect(consumed).toBe(true);
            expect(onRequestClose).toHaveBeenCalledExactlyOnceWith();
            expect(frameProps.at(-1)?.navigationCommand).toBeUndefined();
        } finally {
            await screen?.unmount();
            Platform.OS = originalPlatform;
            nativeBack.reset();
        }
    });

    it('keeps the targeted caller fallback when a current native Artifact frame fails to load', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="targeted-native-load-error-nonce"
                targetedFallback={React.createElement('TargetedHostedFallback', {
                    testID: 'targeted-hosted-native-load-error-fallback',
                })}
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'targeted-native-load-error' } as const)}
            />,
        );

        const loadError = frameProps.at(-1)?.onNativeArtifactLoadError as ((event: unknown) => void) | undefined;
        await act(async () => {
            loadError?.({ nativeEvent: { code: 'hosted_web_artifact_load_failed' } });
        });

        expect(screen.findByTestId('targeted-hosted-native-load-error-fallback')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame-error')).toBeNull();
    });

    it('ignores a stale native adapter-unavailable callback after Artifact target replacement', async () => {
        frameProps.length = 0;
        const first = createHandle();
        const second = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="first-native-target"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(first.handle), mountInstanceKey: 'first-native-target' } as const)}
            />,
        );
        const staleUnavailable = frameProps.at(-1)?.onNativeArtifactUnavailable as (() => void) | undefined;
        expect(staleUnavailable).toBeTypeOf('function');

        await screen.update(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="second-native-target"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(second.handle), mountInstanceKey: 'second-native-target' } as const)}
            />,
        );
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();

        await act(async () => {
            staleUnavailable?.();
        });

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
        expect(second.dispose).not.toHaveBeenCalled();
    });

    it('detaches on Artifact/account revocation without treating the event as target-owned disposal', async () => {
        frameProps.length = 0;
        const native = createHandle();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                platform="ios"
                bridgeNonce="nonce-1"
                {...({ nativeArtifactAdoption: createNativeArtifactAdoption(native.handle), mountInstanceKey: 'target-one' } as const)}
            />,
        );
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();

        await act(async () => {
            native.revoke();
            await Promise.resolve();
        });

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(native.dispose).not.toHaveBeenCalled();
    });

    it('remounts the native Artifact guest when launch facts replace its bound bridge lifetime', async () => {
        frameProps.length = 0;
        frameMountCount = 0;
        frameUnmountCount = 0;
        const artifact = createHandle();
        // Production supplies one stable adoption per bound target; a fresh
        // adoption object per render would retire the live handle.
        const artifactAdoption = createNativeArtifactAdoption(artifact.handle);
        const bridgeSurface: PluginUiSurfaceContextV1 = {
            ...surfaceContext,
            platform: 'ios',
            sessionId: 'session-1',
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const satisfies PluginUiHostApiWireIdentityV1;
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const element = (launchInput: PluginUiLaunchInputV1 | undefined) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={bridgeSurface}
                pluginUiProjection={bridgeProjection}
                platform="ios"
                bridgeNonce="bridge-lifetime-nonce"
                hostApi={{ platform: 'ios', channel: 'internal', handleRequest: async () => null }}
                canonicalHostApi={{
                    identity,
                    mount: canonicalMount,
                    methods: ['executeAction'],
                    target: { kind: 'session', sessionId: 'session-1' },
                    accountEncryptionMode: 'e2ee',
                    translations: {},
                    targetedContributions: canonicalTargetedContributions,
                }}
                nativeArtifactAdoption={artifactAdoption}
                mountInstanceKey="stable-artifact-target"
                launchInput={launchInput}
            />
        );
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(element({ documentId: 'first' }));
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        const firstMountCount = frameMountCount;
        const firstUnmountCount = frameUnmountCount;

        await screen.update(element({ documentId: 'second' }));

        expect(frameMountCount).toBe(firstMountCount + 1);
        expect(frameUnmountCount).toBe(firstUnmountCount + 1);
    });

    it('keeps the native Artifact guest mounted when live surface context facts change', async () => {
        frameProps.length = 0;
        frameMountCount = 0;
        frameUnmountCount = 0;
        const artifact = createHandle();
        // Production supplies one stable adoption per bound target; a fresh
        // adoption object per render would retire the live handle.
        const artifactAdoption = createNativeArtifactAdoption(artifact.handle);
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const satisfies PluginUiHostApiWireIdentityV1;
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const element = (diagnostics: string[]) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{
                    ...surfaceContext,
                    sessionId: 'session-1',
                    diagnostics,
                }}
                pluginUiProjection={bridgeProjection}
                platform="ios"
                bridgeNonce="stable-context-nonce"
                hostApi={{ platform: 'ios', channel: 'internal', handleRequest: async () => null }}
                canonicalHostApi={{
                    identity,
                    mount: canonicalMount,
                    methods: ['context', 'watchContext'],
                    target: { kind: 'session', sessionId: 'session-1' },
                    accountEncryptionMode: 'e2ee',
                    translations: {},
                    targetedContributions: canonicalTargetedContributions,
                }}
                nativeArtifactAdoption={artifactAdoption}
                mountInstanceKey="stable-context-target"
            />
        );
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(element([]));
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        const firstMountCount = frameMountCount;
        const firstUnmountCount = frameUnmountCount;

        await screen.update(element(['context-refreshed']));

        expect(frameMountCount).toBe(firstMountCount);
        expect(frameUnmountCount).toBe(firstUnmountCount);
    });

    it('keeps one native Artifact bridge alive when the installed host handler and canonical context refresh', async () => {
        frameProps.length = 0;
        hostMessages.length = 0;
        frameMountCount = 0;
        frameUnmountCount = 0;
        const artifact = createHandle();
        // Production supplies one stable adoption per bound target; a fresh
        // adoption object per render would retire the live handle.
        const artifactAdoption = createNativeArtifactAdoption(artifact.handle);
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const satisfies PluginUiHostApiWireIdentityV1;
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const element = (
            handleRequest: () => Promise<null>,
            translation: string,
        ) => (
            <PluginHostedWebPane
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, sessionId: 'session-1' }}
                pluginUiProjection={bridgeProjection}
                platform="ios"
                bridgeNonce="stable-native-handler-nonce"
                hostApi={{ platform: 'ios', channel: 'internal', handleRequest }}
                canonicalHostApi={{
                    identity,
                    mount: canonicalMount,
                    methods: ['context', 'watchContext'],
                    target: { kind: 'session', sessionId: 'session-1' },
                    accountEncryptionMode: 'e2ee',
                    translations: { 'preview.frame.title': translation },
                    targetedContributions: canonicalTargetedContributions,
                }}
                nativeArtifactAdoption={artifactAdoption}
                mountInstanceKey="stable-native-handler-target"
            />
        );
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const firstHandleRequest = vi.fn(async () => null);
        const replacementHandleRequest = vi.fn(async () => null);

        const screen = await renderScreen(element(firstHandleRequest, 'First title'));
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        const firstMountCount = frameMountCount;
        const firstUnmountCount = frameUnmountCount;
        hostMessages.length = 0;

        await screen.update(element(replacementHandleRequest, 'Refreshed title'));

        expect(frameMountCount).toBe(firstMountCount);
        expect(frameUnmountCount).toBe(firstUnmountCount);
        expect(hostMessages).not.toContainEqual(expect.objectContaining({
            kind: 'hostApi',
            payload: expect.objectContaining({ kind: 'disconnected' }),
        }));
    });

    it('synchronously retires the native Artifact bridge before its frame attachment detaches', async () => {
            frameProps.length = 0;
            hostMessages.length = 0;
            attachmentTeardownCount = 0;
            const artifact = createHandle();
        // Production supplies one stable adoption per bound target; a fresh
        // adoption object per render would retire the live handle.
        const artifactAdoption = createNativeArtifactAdoption(artifact.handle);
            const dataHandle = vi.fn();
            const dataDispose = vi.fn();
            let dataSignal: AbortSignal | undefined;
            let settleData: ((response: PluginHostedWebAccountDataBridgeResponseV1) => void) | undefined;
            dataHandle.mockImplementation((
                _operation: PluginHostedWebAccountDataBridgeOperationV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => {
                dataSignal = options?.signal;
                return new Promise<PluginHostedWebAccountDataBridgeResponseV1>((resolve) => {
                    settleData = resolve;
                });
            });
            const handleRequest = vi.fn(async () => null);
            const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
            const bridgeProjection: PluginUiProjectionModel = {
                ...projection,
                hostedWebById: {
                    ...projection.hostedWebById,
                    'hostedWeb:acme.preview:preview-web': {
                        ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                        bridge: { allowedMessages: ['hostApi', 'accountData'] },
                    },
                },
            };
            const bridgeSurface: PluginUiSurfaceContextV1 = {
                ...surfaceContext,
                platform: 'ios',
                sessionId: 'session-1',
            };
            const identity = {
                pluginId: 'acme.preview',
                pluginVersion: '1.2.3',
                viewId: 'preview-pane',
                generation: '1',
                sessionId: 'session-1',
            } as const satisfies PluginUiHostApiWireIdentityV1;
            await renderScreen(
                <PluginHostedWebPane
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={bridgeSurface}
                    pluginUiProjection={bridgeProjection}
                    platform="ios"
                    bridgeNonce="artifact-revoke-nonce"
                    isCurrent={() => true}
                    hostApi={{ platform: 'ios', channel: 'internal', handleRequest }}
                    canonicalHostApi={{
                        identity,
                        mount: canonicalMount,
                        methods: ['executeAction'],
                        target: { kind: 'session', sessionId: 'session-1' },
                        accountEncryptionMode: 'e2ee',
                        translations: {},
                        targetedContributions: canonicalTargetedContributions,
                    }}
                    createAccountDataBridge={() => ({ handle: dataHandle, dispose: dataDispose })}
                    nativeArtifactAdoption={artifactAdoption}
                />,
            );

            const bridge = findBridge();
            // Native Artifact activation first replaces the no-frame
            // bootstrap handler with the frame-bound handler. Its obsolete
            // Data bridge is retired before this test's request lifetime.
            dataDispose.mockClear();
            await act(async () => {
                await Promise.resolve(bridge.onMessage(createBridgeEnvelope({
                    surface: bridgeSurface,
                    nonce: 'artifact-revoke-nonce',
                    sequence: 1,
                    kind: 'ready',
                    payload: { ready: true },
                })));
            });
            hostMessages.length = 0;

            const operation: PluginHostedWebAccountDataBridgeOperationV1 = {
                kind: 'open',
                collectionId: 'tasks',
                uiQueryId: 'open',
                parameters: { status: 'open' },
            };
            const pending = Promise.resolve(bridge.onMessage(createBridgeEnvelope({
                surface: bridgeSurface,
                nonce: 'artifact-revoke-nonce',
                sequence: 2,
                kind: 'accountData',
                payload: { kind: 'request', operation },
            })));
            await vi.waitFor(() => expect(dataHandle).toHaveBeenCalledTimes(1));
            expect(dataSignal?.aborted).toBe(false);

            let laterData: Promise<unknown> | undefined;
            let laterHostApi: Promise<unknown> | undefined;
            act(() => {
                artifact.revoke();

                // These facts are synchronous source-revocation obligations:
                // the React detach still has not run while this callback holds
                // the attached frame sink.
                expect(dataSignal?.aborted).toBe(true);
                expect(hostMessages).toContainEqual(expect.objectContaining({
                    kind: 'hostApi',
                    payload: expect.objectContaining({ kind: 'disconnected' }),
                }));
                expect(attachmentTeardownCount).toBe(0);

                laterData = Promise.resolve(bridge.onMessage(createBridgeEnvelope({
                    surface: bridgeSurface,
                    nonce: 'artifact-revoke-nonce',
                    sequence: 3,
                    kind: 'accountData',
                    payload: { kind: 'request', operation },
                })));
                laterHostApi = Promise.resolve(bridge.onMessage(createBridgeEnvelope({
                    surface: bridgeSurface,
                    nonce: 'artifact-revoke-nonce',
                    sequence: 4,
                    kind: 'hostApi',
                    payload: {
                        wireVersion: 1,
                        kind: 'request',
                        identity,
                        requestId: 'post-revoke-host-api',
                        method: 'executeAction',
                        payload: { action: 'open' },
                    },
                })));
            });

            await expect(laterData).resolves.toMatchObject({
                kind: 'error',
                payload: { code: 'stale_surface' },
            });
            await expect(laterHostApi).resolves.toMatchObject({
                kind: 'error',
                payload: { code: 'stale_surface' },
            });
            expect(dataHandle).toHaveBeenCalledTimes(1);
            expect(handleRequest).not.toHaveBeenCalled();

            settleData?.({
                kind: 'snapshot',
                queryId: 'open',
                snapshot: { status: 'ready', rows: [], hasMore: false },
            });
            await expect(pending).resolves.toMatchObject({ kind: 'ack', requestSequence: 2 });
            expect(dataDispose).toHaveBeenCalledTimes(1);
    });
});
