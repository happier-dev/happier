import {
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    resolvePluginHostedWebNativeArtifactFrameOriginV1,
    type PluginHostedWebBridgeBootstrapConfigV1,
    type UiSurfaceNetworkOriginV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import { Platform } from 'react-native';
import {
    requireNativeModule,
    requireNativeViewManager,
} from 'expo-modules-core';

import { randomUUID } from '@/platform/randomUUID';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { BrowserFrameMessageReceipt } from '@/components/browser/frame/types';

import { buildHostedHtmlDocument } from './buildHostedHtmlDocument';
import {
    createPluginHostedWebNativeMessageBridge,
    PLUGIN_HOSTED_WEB_NO_TRANSIENT_ACTIVATION_RECEIPT,
    type PluginHostedWebNativeBridgeConfig,
} from './nativeMessageBridge';
import type { HostedInlineDocumentFrameUnavailableCode } from './hostedInlineDocumentFrameTypes';

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
    registerInlineDocument?: (input: Readonly<{ token: string; html: string; contentSecurityPolicy: string }>) => Promise<unknown>;
    /** Synchronous revocation acknowledgement for one process-local document. */
    unregisterInlineDocument?: (token: string) => boolean;
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
    /** Host-resolved accessible title for the child native WebView. */
    title: string;
    artifactHandleToken?: string;
    inlineDocumentHandleToken?: string;
    initialPathAndQuery: string;
    allowedNavigationOrigins: readonly string[];
    externalHttpLinks?: boolean;
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

/** Caller HTML is available only when the compiled adapter also has its registrar. */
export function isHostedInlineDocumentFrameNativeAdapterAvailable(): boolean {
    const adapter = resolveNativeAdapter();
    return adapter !== null
        && typeof adapter.module.registerInlineDocument === 'function'
        && typeof adapter.module.unregisterInlineDocument === 'function';
}

type HostedNativeFrameSharedProps = Readonly<{
    /** Host-resolved accessible title for the child native WebView. */
    title: string;
    allowedNavigationOrigins: readonly string[];
    /** Caller-authored inline documents alone may mediate activated HTTP(S) anchors. */
    externalHttpLinks?: boolean;
    attachHostMessages?: (send: (message: unknown) => void) => () => void;
    onMessage?: (
        event: HostedArtifactFrameNativeMessageEvent,
        receipt: BrowserFrameMessageReceipt,
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
    testID: string;
}>;

type HostedArtifactFrameProps = HostedNativeFrameSharedProps & Readonly<{
    /** Artifact-owned opaque registration token; never an address or cache key. */
    artifactHandleToken: string;
    /** Host-built address facts only (the entry path plus bridge correlation). */
    initialPathAndQuery: string;
    onUnavailable?: (code: 'native_frame_adapter_unavailable') => void;
}>;

type LoadedHostedNativeFrameProps = HostedNativeFrameSharedProps & Readonly<{
    adapter: NativeAdapter;
    source:
        | Readonly<{ kind: 'artifact'; token: string; initialPathAndQuery: string }>
        | Readonly<{ kind: 'inlineDocument'; token: string }>;
    onUnavailable?: (code: 'native_frame_adapter_unavailable') => void;
}>;

function LoadedHostedNativeFrame(props: LoadedHostedNativeFrameProps): React.ReactElement {
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
        if (!mountedRef.current) return;
        let response: unknown | Promise<unknown>;
        try {
            response = props.onMessage?.(event, PLUGIN_HOSTED_WEB_NO_TRANSIENT_ACTIVATION_RECEIPT);
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
        void openExternalUrl(url);
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
            title={props.title}
            {...(props.source.kind === 'artifact'
                ? {
                    artifactHandleToken: props.source.token,
                    initialPathAndQuery: props.source.initialPathAndQuery,
                }
                : {
                    inlineDocumentHandleToken: props.source.token,
                    initialPathAndQuery: '/',
                })}
            allowedNavigationOrigins={props.allowedNavigationOrigins}
            externalHttpLinks={props.externalHttpLinks}
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
    return (
        <LoadedHostedNativeFrame
            {...props}
            adapter={adapter}
            source={{
                kind: 'artifact',
                token: props.artifactHandleToken,
                initialPathAndQuery: props.initialPathAndQuery,
            }}
        />
    );
}

type HostedInlineDocumentFrameProps = HostedNativeFrameSharedProps & Readonly<{
    bundle: ArtifactHtmlBundleV1;
    networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1;
    bridge?: (PluginHostedWebNativeBridgeConfig & Readonly<{
        attachHostMessages?: (send: (message: unknown) => void) => () => void;
    }>) | null;
    onUnavailable?: (code: HostedInlineDocumentFrameUnavailableCode) => void;
}>;

type InlineDocumentGeneration = Readonly<{
    token: string;
    physicalFrameOrigin: string;
    documentHtml: string;
}>;

function createInlineDocumentGeneration(documentHtml: string | null): InlineDocumentGeneration | null {
    if (documentHtml === null) return null;
    const platform = Platform.OS;
    if (platform !== 'ios' && platform !== 'android') return null;
    try {
        // The incumbent Protocol origin grammar already requires a 256-bit
        // opaque partition id. Two platform UUIDs supply that token without
        // adding another identity format or native lookup API.
        const token = `hpa_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
        const physicalFrameOrigin = resolvePluginHostedWebNativeArtifactFrameOriginV1({
            platform,
            storagePartitionId: token,
        });
        if (!physicalFrameOrigin) return null;
        return Object.freeze({
            token,
            physicalFrameOrigin,
            documentHtml,
        });
    } catch {
        return null;
    }
}

function readInlineRegistrationUnavailableCode(value: unknown): HostedInlineDocumentFrameUnavailableCode | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'native_inline_document_registration_failed';
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    if (record.kind === 'registered' && keys.length === 1) return null;
    if (record.kind !== 'unavailable' || typeof record.code !== 'string') {
        return 'native_inline_document_registration_failed';
    }
    if (record.code === 'hosted_web_profile_isolation_unavailable') {
        const expectedKeys = record.capability === undefined
            ? ['code', 'kind']
            : ['capability', 'code', 'kind'];
        return typeof record.capability !== 'string'
            || keys.length !== expectedKeys.length
            || expectedKeys.some((key) => !keys.includes(key))
            ? 'native_inline_document_registration_failed'
            : record.code;
    }
    return record.code === 'native_inline_document_registration_failed'
        && keys.length === 2
        && keys.includes('kind')
        && keys.includes('code')
        ? record.code
        : 'native_inline_document_registration_failed';
}

/**
 * Process-local caller document registration around the incumbent isolated
 * native frame. Raw HTML terminates here; the native view receives only the
 * opaque token for the exact current generation.
 */
export function HostedInlineDocumentFrame(
    props: HostedInlineDocumentFrameProps,
): React.ReactElement | null {
    const adapter = React.useMemo(resolveNativeAdapter, []);
    const documentHtml = React.useMemo(() => {
        try {
            return buildHostedHtmlDocument(
                props.bundle,
                props.bootstrapConfig,
                { networkOrigins: props.networkOrigins, externalHttpLinks: props.externalHttpLinks },
            );
        } catch {
            // The outer surface admission normally rejects malformed input. Keep
            // this physical boundary fail-closed if it is called independently.
            return null;
        }
    }, [props.bundle, props.bootstrapConfig, props.networkOrigins, props.externalHttpLinks]);
    const generation = React.useMemo(
        () => createInlineDocumentGeneration(documentHtml),
        [documentHtml],
    );
    const [registeredToken, setRegisteredToken] = React.useState<string | null>(null);
    const registeredTokenRef = React.useRef<string | null>(null);
    const onUnavailableRef = React.useRef(props.onUnavailable);
    onUnavailableRef.current = props.onUnavailable;
    const revokeToken = React.useCallback((token: string) => {
        try {
            adapter?.module.unregisterInlineDocument?.(token);
        } catch {
            // Native revocation is idempotent. A bridge exception cannot make
            // this generation current again or justify mounting raw HTML.
        }
    }, [adapter]);
    const notifyUnavailable = React.useCallback((code: HostedInlineDocumentFrameUnavailableCode) => {
        try {
            onUnavailableRef.current?.(code);
        } catch {
            // Presentation callbacks cannot weaken physical admission or turn
            // a denied document into an uncaught render failure.
        }
    }, []);

    React.useLayoutEffect(() => {
        registeredTokenRef.current = null;
        setRegisteredToken(null);
        const register = adapter?.module.registerInlineDocument;
        const unregister = adapter?.module.unregisterInlineDocument;
        if (!adapter || typeof register !== 'function' || typeof unregister !== 'function') {
            notifyUnavailable('native_frame_adapter_unavailable');
            return;
        }
        if (!generation) {
            notifyUnavailable('native_inline_document_registration_failed');
            return;
        }

        let current = true;
        let request: Promise<unknown>;
        try {
            request = Promise.resolve(register({
                token: generation.token,
                html: generation.documentHtml,
                contentSecurityPolicy: ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1,
            }));
        } catch {
            revokeToken(generation.token);
            notifyUnavailable('native_inline_document_registration_failed');
            return;
        }
        void request.then((result) => {
            const unavailable = readInlineRegistrationUnavailableCode(result);
            if (!current) {
                revokeToken(generation.token);
                return;
            }
            if (unavailable) {
                revokeToken(generation.token);
                notifyUnavailable(unavailable);
                return;
            }
            registeredTokenRef.current = generation.token;
            setRegisteredToken(generation.token);
        }).catch(() => {
            revokeToken(generation.token);
            if (current) notifyUnavailable('native_inline_document_registration_failed');
        });

        return () => {
            // Native revocation is synchronous. If registration is still on
            // its native queue, the completion branch repeats this exact
            // revocation before a stale generation can ever be mounted.
            current = false;
            if (registeredTokenRef.current === generation.token) {
                registeredTokenRef.current = null;
            }
            revokeToken(generation.token);
        };
    }, [adapter, generation, notifyUnavailable, revokeToken]);

    const retireCurrentGeneration = React.useCallback((code: HostedInlineDocumentFrameUnavailableCode) => {
        if (!generation || registeredTokenRef.current !== generation.token) return;
        registeredTokenRef.current = null;
        revokeToken(generation.token);
        setRegisteredToken((current) => current === generation.token ? null : current);
        notifyUnavailable(code);
    }, [generation, notifyUnavailable, revokeToken]);
    const handleInlineLoadError = React.useCallback((event: unknown) => {
        try {
            props.onLoadError?.(event);
        } catch {
            // Keep terminal retirement independent from presentation handling.
        }
        const nativeEvent = event && typeof event === 'object'
            ? Reflect.get(event, 'nativeEvent')
            : null;
        const code = nativeEvent && typeof nativeEvent === 'object'
            ? Reflect.get(nativeEvent, 'code')
            : null;
        retireCurrentGeneration(code === 'hosted_web_profile_isolation_unavailable'
            ? 'hosted_web_profile_isolation_unavailable'
            : 'native_inline_document_load_failed');
    }, [props.onLoadError, retireCurrentGeneration]);
    const handleInlineBlockedNavigation = React.useCallback((event: unknown) => {
        try {
            props.onBlockedNavigation?.(event);
        } catch {
            // Keep terminal retirement independent from presentation handling.
        }
        retireCurrentGeneration('native_inline_document_load_failed');
    }, [props.onBlockedNavigation, retireCurrentGeneration]);

    if (!adapter || !generation || registeredToken !== generation.token) return null;
    const bridge = props.bridge;
    const onMessage = bridge
        ? createPluginHostedWebNativeMessageBridge({
            bridge,
            physicalFrameOrigin: generation.physicalFrameOrigin,
        })
        : undefined;
    const { onUnavailable: _onUnavailable, ...frameProps } = props;
    return (
        <LoadedHostedNativeFrame
            key={generation.token}
            {...frameProps}
            adapter={adapter}
            source={{ kind: 'inlineDocument', token: generation.token }}
            onLoadError={handleInlineLoadError}
            onBlockedNavigation={handleInlineBlockedNavigation}
            {...(bridge?.attachHostMessages ? { attachHostMessages: bridge.attachHostMessages } : {})}
            {...(onMessage ? { onMessage } : {})}
        />
    );
}
