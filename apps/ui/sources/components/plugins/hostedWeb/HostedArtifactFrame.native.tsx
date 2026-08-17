import {
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { Linking } from 'react-native';
import {
    requireNativeModule,
    requireNativeViewManager,
} from 'expo-modules-core';

type HostedArtifactFrameNativeModule = Readonly<{
    /**
     * Expo exposes a view AsyncFunction on the module proxy in development
     * builds. The normal production path uses the view prototype below, but
     * retaining this narrow invocation shape lets the same adapter work with
     * both Expo bridge implementations without widening the renderer input.
     */
    postHostMessage?: (view: unknown, serializedMessage: string) => Promise<boolean> | boolean;
    /** The view-owned native history command; never a guest-controlled URL. */
    goBack?: (view: unknown) => Promise<boolean> | boolean;
}>;

type HostedArtifactFrameNativeMessageEvent = Readonly<{
    nativeEvent?: Readonly<{
        data?: unknown;
        url?: unknown;
    }>;
}>;

type HostedArtifactFrameNativeLoadErrorEvent = Readonly<{
    nativeEvent?: Readonly<{
        code?: unknown;
        capability?: unknown;
        webViewPackage?: unknown;
        webViewVersion?: unknown;
    }>;
}>;

type HostedArtifactFrameNativeHistoryStateEvent = Readonly<{
    nativeEvent?: Readonly<{
        canGoBack?: unknown;
    }>;
}>;

type HostedArtifactFrameNavigationCommand = Readonly<{
    commandId: string;
    kind: 'goBack';
}>;

type HostedArtifactFrameNativeViewProps = Readonly<{
    artifactHandleToken: string;
    initialPathAndQuery: string;
    allowedNavigationOrigins: readonly string[];
    onMessage?: (event: HostedArtifactFrameNativeMessageEvent) => unknown;
    onLoadStart?: (event: unknown) => void;
    onLoadEnd?: (event: unknown) => void;
    onLoadError?: (event: HostedArtifactFrameNativeLoadErrorEvent) => void;
    onExternalNavigation?: (event: unknown) => void;
    onBlockedNavigation?: (event: unknown) => void;
    onHistoryStateChange?: (event: HostedArtifactFrameNativeHistoryStateEvent) => void;
    testID: string;
}>;

type HostedArtifactFrameNativeViewHandle = Readonly<{
    postHostMessage?: (serializedMessage: string) => Promise<boolean> | boolean;
    goBack?: () => Promise<boolean> | boolean;
}>;

type HostedArtifactFrameNativeView = React.ForwardRefExoticComponent<
    HostedArtifactFrameNativeViewProps & React.RefAttributes<HostedArtifactFrameNativeViewHandle>
>;

type NativeAdapter = Readonly<{
    module: HostedArtifactFrameNativeModule;
    View: HostedArtifactFrameNativeView;
}>;

function resolveNativeAdapter(): NativeAdapter | null {
    try {
        return Object.freeze({
            module: requireNativeModule<HostedArtifactFrameNativeModule>('HappierHostedWebFrame'),
            // The native view manager is an external bridge boundary. Its
            // declared component type does not retain the imperative view
            // handle, while this adapter needs only that one typed method.
            View: requireNativeViewManager<HostedArtifactFrameNativeViewProps>(
                'HappierHostedWebFrame',
            ) as unknown as HostedArtifactFrameNativeView,
        });
    } catch {
        return null;
    }
}

/**
 * Factual native-frame availability for the hosted-web capability projection.
 * This intentionally delegates to the same resolver the renderer uses, so a
 * compiled module without its matching view manager is never advertised.
 */
export function isHostedArtifactFrameNativeAdapterAvailable(): boolean {
    return resolveNativeAdapter() !== null;
}

type HostedArtifactFrameProps = Readonly<{
    /** Artifact-owned opaque registration token; never an address or cache key. */
    artifactHandleToken: string;
    /** Host-built address facts only (the entry path plus bridge correlation). */
    initialPathAndQuery: string;
    allowedNavigationOrigins: readonly string[];
    attachHostMessages?: (send: (message: unknown) => void) => () => void;
    onMessage?: (
        event: HostedArtifactFrameNativeMessageEvent,
    ) => unknown | Promise<unknown>;
    onLoadStart?: (event: unknown) => void;
    onLoadEnd?: (event: unknown) => void;
    onLoadError?: (event: unknown) => void;
    onExternalNavigation?: (event: unknown) => void;
    onBlockedNavigation?: (event: unknown) => void;
    /** Native-only guest history fact for this exact mounted Artifact frame. */
    onHistoryStateChange?: (canGoBack: boolean) => void;
    /** Existing frame command vocabulary narrowed to its native Artifact arm. */
    navigationCommand?: HostedArtifactFrameNavigationCommand;
    /** Returns the native command outcome to the pane's currentness owner. */
    onGoBackResult?: (handled: boolean) => void;
    onUnavailable?: (code: 'native_frame_adapter_unavailable') => void;
    testID: string;
}>;

function LoadedHostedArtifactFrame(props: HostedArtifactFrameProps & Readonly<{
    adapter: NativeAdapter;
}>): React.ReactElement {
    const viewRef = React.useRef<HostedArtifactFrameNativeViewHandle | null>(null);
    const mountedRef = React.useRef(false);
    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const sendHostMessage = React.useCallback((message: unknown) => {
        let serializedMessage: string;
        try {
            serializedMessage = JSON.stringify(message);
        } catch {
            // The canonical bridge sends Protocol JSON values. A malformed
            // producer is denied here instead of turning this transport into
            // a second serialization/error policy owner.
            return;
        }
        const nativeModulePost = props.adapter.module.postHostMessage;
        if (typeof nativeModulePost === 'function') {
            // A ref object is accepted by Expo's module proxy and remains a
            // stable view carrier before the host component has committed.
            // The production-native view prototype below is the fallback for
            // bridge implementations that expose view AsyncFunctions only on
            // the mounted view instance.
            void Promise.resolve(nativeModulePost(viewRef.current ?? viewRef, serializedMessage)).catch(() => {});
            return;
        }
        void Promise.resolve(viewRef.current?.postHostMessage?.(serializedMessage)).catch(() => {});
    }, [props.adapter.module]);
    const handleNativeMessage = React.useCallback((event: HostedArtifactFrameNativeMessageEvent) => {
        let response: unknown | Promise<unknown>;
        try {
            response = props.onMessage?.(event);
        } catch {
            return;
        }
        if (response === undefined) return;

        // Native view callbacks discard return values. Reuse the incumbent
        // host->frame primitive for the only valid bridge response shape,
        // matching the desktop Artifact adapter without creating a second
        // transport, queue, or response vocabulary.
        void Promise.resolve(response).then((value) => {
            if (!mountedRef.current) return;
            const parsed = PluginHostedWebBridgeResponseEnvelopeV1Schema.safeParse(value);
            if (parsed.success && mountedRef.current) sendHostMessage(parsed.data);
        }).catch(() => {});
    }, [props.onMessage, sendHostMessage]);

    // A terminal bridge message is still addressed to this incumbent native
    // view. Layout cleanup returns the borrowed primitive before its ref is
    // cleared, unlike passive cleanup which would lose that final delivery.
    React.useLayoutEffect(() => props.attachHostMessages?.(sendHostMessage), [
        props.attachHostMessages,
        sendHostMessage,
    ]);
    const handoffExternalNavigation = React.useCallback((event: unknown) => {
        const nativeEvent = event && typeof event === 'object'
            ? (event as Readonly<{ nativeEvent?: unknown }>).nativeEvent
            : null;
        const url = nativeEvent && typeof nativeEvent === 'object'
            ? (nativeEvent as Readonly<{ url?: unknown }>).url
            : null;
        if (typeof url !== 'string' || url.length === 0) return;
        // The native frame emits this event only after the protocol-declared
        // origin policy accepts the URL. It has already cancelled the WebView
        // navigation; this is the host-mediated external handoff.
        void Linking.openURL(url).catch(() => {});
    }, []);
    const handleLoadError = React.useCallback((event: HostedArtifactFrameNativeLoadErrorEvent) => {
        props.onLoadError?.(event);
        if (event.nativeEvent?.code === 'hosted_web_profile_isolation_unavailable') {
            // This is a native capability admission failure, not a second
            // renderer policy: route it through the adapter's existing typed
            // unavailable seam so the Artifact owner selects its fallback.
            props.onUnavailable?.('native_frame_adapter_unavailable');
        }
    }, [props.onLoadError, props.onUnavailable]);
    const handleHistoryStateChange = React.useCallback((event: HostedArtifactFrameNativeHistoryStateEvent) => {
        // Native history is a presentation fact. Treat an absent or malformed
        // system event as no history rather than lending a stale frame Back.
        props.onHistoryStateChange?.(event.nativeEvent?.canGoBack === true);
    }, [props.onHistoryStateChange]);
    const navigationCommand = props.navigationCommand;
    React.useEffect(() => {
        if (navigationCommand?.kind !== 'goBack') return;
        let active = true;
        const nativeModuleGoBack = props.adapter.module.goBack;
        const request = typeof nativeModuleGoBack === 'function'
            ? nativeModuleGoBack(viewRef.current ?? viewRef)
            : viewRef.current?.goBack?.() ?? false;
        void Promise.resolve(request).then((handled) => {
            if (active) props.onGoBackResult?.(handled === true);
        }).catch(() => {
            if (active) props.onGoBackResult?.(false);
        });
        return () => {
            active = false;
        };
    }, [navigationCommand?.commandId, navigationCommand?.kind, props.adapter.module, props.onGoBackResult]);

    return (
        <props.adapter.View
            ref={viewRef}
            artifactHandleToken={props.artifactHandleToken}
            initialPathAndQuery={props.initialPathAndQuery}
            allowedNavigationOrigins={props.allowedNavigationOrigins}
            onMessage={handleNativeMessage}
            onLoadStart={props.onLoadStart}
            onLoadEnd={props.onLoadEnd}
            onLoadError={handleLoadError}
            onExternalNavigation={handoffExternalNavigation}
            onBlockedNavigation={props.onBlockedNavigation}
            onHistoryStateChange={handleHistoryStateChange}
            testID={props.testID}
        />
    );
}

/**
 * Native Artifact frame seam. Its public input is deliberately incapable of
 * supplying a URL, raw bytes, file path, Account coordinate, or cache source:
 * those remain with the Artifact lease and the compiled native adapter.
 */
export function HostedArtifactFrame(props: HostedArtifactFrameProps): React.ReactElement | null {
    const adapter = React.useMemo(resolveNativeAdapter, []);
    React.useEffect(() => {
        if (!adapter) props.onUnavailable?.('native_frame_adapter_unavailable');
    }, [adapter, props.onUnavailable]);
    if (!adapter) return null;
    return <LoadedHostedArtifactFrame {...props} adapter={adapter} />;
}
