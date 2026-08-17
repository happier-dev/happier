import {
    PluginHostedWebBridgeHostMessageEnvelopeV1Schema,
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginHostedWebBridgeHostMessageEnvelopeV1,
    type PluginHostedWebBridgeResponseEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import type { BrowserFrameNavigationCommand } from '@/components/browser/frame/types';
import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';

import { createPluginHostedWebNativeMessageBridge } from './nativeMessageBridge';

const HOST_EVENT = 'desktop-hosted-artifact-event';
const OPEN_VIEW_COMMAND = 'desktop_hosted_artifact_open_view';
const SET_BOUNDS_COMMAND = 'desktop_hosted_artifact_set_bounds';
const POST_MESSAGE_COMMAND = 'desktop_hosted_artifact_post_message';
const GO_BACK_COMMAND = 'desktop_hosted_artifact_go_back';
const CLOSE_VIEW_COMMAND = 'desktop_hosted_artifact_close_view';

type DesktopArtifactBridge = Readonly<{
    expectedOrigin: string;
    expectedPluginId: string;
    expectedContributionId: string;
    expectedSurfaceId: string;
    expectedNonce: string;
    expectedSessionId?: string | null;
    allowedMessageKinds: ReadonlySet<string>;
    attachHostMessages?: (send: (message: unknown) => void) => () => void;
    onMessage: (
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void>;
}>;

type DesktopArtifactViewProps = Readonly<{
    artifact: Readonly<{
        artifactHandleToken: string;
        initialPathAndQuery: string;
    }>;
    bridge?: DesktopArtifactBridge | null;
    testID: string;
    nativeArtifactLoadState?: 'loading' | 'ready';
    onNativeArtifactUnavailable?: () => void;
    onNativeArtifactLoadStart?: (event: unknown) => void;
    onNativeArtifactLoadEnd?: (event: unknown) => void;
    onNativeArtifactLoadError?: (event: unknown) => void;
    navigationCommand?: BrowserFrameNavigationCommand;
    onNativeArtifactHistoryStateChange?: (canGoBack: boolean) => void;
    onNativeArtifactGoBackResult?: (handled: boolean) => void;
}>;

type HostEvent =
    | Readonly<{ viewId: string; kind: 'loadStarted' | 'loadFinished' }>
    | Readonly<{ viewId: string; kind: 'historyState'; canGoBack: boolean }>
    | Readonly<{ viewId: string; kind: 'message'; message: string }>
    | Readonly<{ viewId: string; kind: 'error'; code: string }>;

type NativeViewNode = Readonly<{
    getBoundingClientRect?: () => Readonly<{
        x?: number;
        y?: number;
        left?: number;
        top?: number;
        width: number;
        height: number;
    }>;
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;

type ViewBounds = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

type GuestMessage = PluginHostedWebBridgeHostMessageEnvelopeV1 | PluginHostedWebBridgeResponseEnvelopeV1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function readHostEvent(value: unknown): HostEvent | null {
    if (!isRecord(value) || typeof value.viewId !== 'string' || value.viewId.length === 0 || typeof value.kind !== 'string') {
        return null;
    }
    if ((value.kind === 'loadStarted' || value.kind === 'loadFinished') && hasExactlyKeys(value, ['viewId', 'kind'])) {
        return { viewId: value.viewId, kind: value.kind };
    }
    if (value.kind === 'historyState' && typeof value.canGoBack === 'boolean' && hasExactlyKeys(value, ['viewId', 'kind', 'canGoBack'])) {
        return { viewId: value.viewId, kind: 'historyState', canGoBack: value.canGoBack };
    }
    if (value.kind === 'message' && typeof value.message === 'string' && hasExactlyKeys(value, ['viewId', 'kind', 'message'])) {
        return { viewId: value.viewId, kind: 'message', message: value.message };
    }
    if (value.kind === 'error' && typeof value.code === 'string' && value.code.length > 0 && hasExactlyKeys(value, ['viewId', 'kind', 'code'])) {
        return { viewId: value.viewId, kind: 'error', code: value.code };
    }
    return null;
}

function isOpenedResult(value: unknown): boolean {
    return isRecord(value) && value.kind === 'opened' && hasExactlyKeys(value, ['kind']);
}

function readGoBackHandledResult(value: unknown): boolean | null {
    return isRecord(value)
        && value.kind === 'handled'
        && typeof value.handled === 'boolean'
        && hasExactlyKeys(value, ['kind', 'handled'])
        ? value.handled
        : null;
}

function createViewId(): string | null {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') return null;
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `hpa_view_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function readBounds(value: Readonly<{
    x?: number;
    y?: number;
    left?: number;
    top?: number;
    width: number;
    height: number;
}>): ViewBounds | null {
    const x = value.x ?? value.left;
    const y = value.y ?? value.top;
    if (typeof x !== 'number' || typeof y !== 'number'
        || !Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(value.width) || !Number.isFinite(value.height)
        || value.width < 0 || value.height < 0) {
        return null;
    }
    return {
        x,
        y,
        width: value.width,
        height: value.height,
    };
}

function boundsEqual(left: ViewBounds | null, right: ViewBounds): boolean {
    return left?.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

/**
 * The direct Wry child host for a preselected native Artifact. It owns only
 * the view's trusted command/event transport and geometry; Artifact remains
 * the authority for cache bytes, registration, currentness, and retirement.
 */
export function PluginHostedArtifactDesktopViewHost(props: DesktopArtifactViewProps): React.ReactElement {
    const viewIdRef = React.useRef<string | null>(null);
    if (viewIdRef.current === null) viewIdRef.current = createViewId();
    const viewId = viewIdRef.current;
    const containerRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const openedRef = React.useRef(false);
    const [isOpen, setIsOpen] = React.useState(false);
    const mountedRef = React.useRef(true);
    const pendingGuestMessagesRef = React.useRef<GuestMessage[]>([]);
    const lastBoundsRef = React.useRef<ViewBounds | null>(null);
    const lastVisibleRef = React.useRef<boolean | null>(null);
    const pendingBoundsFrameRef = React.useRef<unknown>(null);
    const callbacksRef = React.useRef(props);
    callbacksRef.current = props;
    const loadStateRef = React.useRef(props.nativeArtifactLoadState ?? 'loading');
    loadStateRef.current = props.nativeArtifactLoadState ?? 'loading';

    const dispatchGuestMessage = React.useCallback((message: GuestMessage) => {
        if (!viewId || !openedRef.current || !mountedRef.current) return;
        void invokeTauri<unknown>(POST_MESSAGE_COMMAND, {
            request: {
                viewId,
                token: props.artifact.artifactHandleToken,
                message,
            },
        }).catch(() => undefined);
    }, [props.artifact.artifactHandleToken, viewId]);

    const postGuestMessage = React.useCallback((message: GuestMessage) => {
        if (!viewId || !mountedRef.current) return;
        if (!openedRef.current) {
            pendingGuestMessagesRef.current.push(message);
            return;
        }
        dispatchGuestMessage(message);
    }, [dispatchGuestMessage, viewId]);

    const flushPendingGuestMessages = React.useCallback(() => {
        if (!openedRef.current || !mountedRef.current) {
            pendingGuestMessagesRef.current = [];
            return;
        }
        const pending = pendingGuestMessagesRef.current;
        pendingGuestMessagesRef.current = [];
        for (const message of pending) dispatchGuestMessage(message);
    }, [dispatchGuestMessage]);

    const nativeMessageBridge = React.useMemo(() => props.bridge
        ? createPluginHostedWebNativeMessageBridge({
            bridge: props.bridge,
        })
        : null, [props.bridge]);
    const nativeMessageBridgeRef = React.useRef(nativeMessageBridge);
    nativeMessageBridgeRef.current = nativeMessageBridge;

    const handleNativeEvent = React.useCallback((payload: unknown) => {
        const event = readHostEvent(payload);
        if (!event || event.viewId !== viewId || !mountedRef.current) return;
        if (event.kind === 'loadStarted') {
            callbacksRef.current.onNativeArtifactLoadStart?.({ nativeEvent: event });
            return;
        }
        if (event.kind === 'loadFinished') {
            callbacksRef.current.onNativeArtifactLoadEnd?.({ nativeEvent: event });
            return;
        }
        if (event.kind === 'historyState') {
            callbacksRef.current.onNativeArtifactHistoryStateChange?.(event.canGoBack);
            return;
        }
        if (event.kind === 'error') {
            callbacksRef.current.onNativeArtifactLoadError?.({ nativeEvent: event });
            return;
        }
        if (event.kind !== 'message') return;
        // Desktop IPC has no WebView URL field. The exact checked `viewId`
        // above is its sender binding, so this owner supplies the one explicit
        // verified sender fact before the shared native bridge validates it.
        const verifiedSenderUrl = callbacksRef.current.bridge?.expectedOrigin;
        if (!verifiedSenderUrl) return;
        const response = nativeMessageBridgeRef.current?.({
            nativeEvent: { data: event.message, url: verifiedSenderUrl },
        });
        if (response === undefined) return;
        void Promise.resolve(response).then((value) => {
            const parsed = PluginHostedWebBridgeResponseEnvelopeV1Schema.safeParse(value);
            if (parsed.success) postGuestMessage(parsed.data);
        }).catch(() => undefined);
    }, [postGuestMessage, viewId]);

    React.useEffect(() => {
        const attach = props.bridge?.attachHostMessages;
        if (!attach) return;
        return attach((message) => {
            const parsed = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse(message);
            if (parsed.success) postGuestMessage(parsed.data);
        });
    }, [postGuestMessage, props.bridge?.attachHostMessages]);

    const publishBounds = React.useCallback((bounds: ViewBounds) => {
        if (!viewId || !openedRef.current || !mountedRef.current) return;
        // Wry paints above the React tree. Keep its child hidden until the
        // trusted load event lets the pane retire its existing loading view.
        const visible = loadStateRef.current === 'ready' && bounds.width > 0 && bounds.height > 0;
        if (boundsEqual(lastBoundsRef.current, bounds) && lastVisibleRef.current === visible) return;
        lastBoundsRef.current = bounds;
        lastVisibleRef.current = visible;
        void invokeTauri<unknown>(SET_BOUNDS_COMMAND, {
            request: {
                viewId,
                token: props.artifact.artifactHandleToken,
                bounds,
                visible,
            },
        }).catch(() => undefined);
    }, [props.artifact.artifactHandleToken, viewId]);

    const measureAndPublishBounds = React.useCallback(() => {
        const node = containerRef.current as unknown as NativeViewNode | null;
        if (node?.getBoundingClientRect) {
            const bounds = readBounds(node.getBoundingClientRect());
            if (bounds) publishBounds(bounds);
            return;
        }
        node?.measureInWindow?.((x, y, width, height) => {
            const bounds = readBounds({ x, y, width, height });
            if (bounds) publishBounds(bounds);
        });
    }, [publishBounds]);

    const scheduleBoundsSync = React.useCallback(() => {
        if (!openedRef.current || !mountedRef.current || pendingBoundsFrameRef.current !== null) return;
        const schedule = globalThis.requestAnimationFrame;
        pendingBoundsFrameRef.current = typeof schedule === 'function'
            ? schedule(() => {
                pendingBoundsFrameRef.current = null;
                measureAndPublishBounds();
            })
            : setTimeout(() => {
                pendingBoundsFrameRef.current = null;
                measureAndPublishBounds();
            }, 0);
    }, [measureAndPublishBounds]);

    React.useEffect(() => {
        mountedRef.current = true;
        setIsOpen(false);
        if (!viewId) {
            callbacksRef.current.onNativeArtifactUnavailable?.();
            return () => {
                mountedRef.current = false;
            };
        }
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const close = () => {
            pendingGuestMessagesRef.current = [];
            if (!openedRef.current) return;
            openedRef.current = false;
            void invokeTauri<unknown>(CLOSE_VIEW_COMMAND, {
                request: {
                    viewId,
                    token: props.artifact.artifactHandleToken,
                },
            }).catch(() => undefined);
        };
        const open = async () => {
            try {
                const removeListener = await listenTauriEvent<unknown>(HOST_EVENT, handleNativeEvent);
                if (disposed) {
                    removeListener();
                    return;
                }
                unlisten = removeListener;
            } catch {
                pendingGuestMessagesRef.current = [];
                if (!disposed) {
                    mountedRef.current = false;
                    callbacksRef.current.onNativeArtifactUnavailable?.();
                }
                return;
            }
            let result: unknown;
            try {
                result = await invokeTauri<unknown>(OPEN_VIEW_COMMAND, {
                    request: {
                        viewId,
                        token: props.artifact.artifactHandleToken,
                        initialPathAndQuery: props.artifact.initialPathAndQuery,
                    },
                });
            } catch {
                pendingGuestMessagesRef.current = [];
                if (!disposed) {
                    mountedRef.current = false;
                    callbacksRef.current.onNativeArtifactUnavailable?.();
                }
                return;
            }
            if (!isOpenedResult(result)) {
                pendingGuestMessagesRef.current = [];
                if (!disposed) {
                    mountedRef.current = false;
                    callbacksRef.current.onNativeArtifactUnavailable?.();
                }
                return;
            }
            openedRef.current = true;
            if (disposed) {
                close();
                return;
            }
            setIsOpen(true);
            flushPendingGuestMessages();
            scheduleBoundsSync();
        };
        void open();
        return () => {
            disposed = true;
            mountedRef.current = false;
            unlisten?.();
            close();
        };
    }, [flushPendingGuestMessages, handleNativeEvent, props.artifact.artifactHandleToken, props.artifact.initialPathAndQuery, scheduleBoundsSync, viewId]);

    React.useEffect(() => {
        const navigationCommand = props.navigationCommand;
        if (!isOpen || !viewId || !openedRef.current || navigationCommand?.kind !== 'goBack') return;
        let active = true;
        void invokeTauri<unknown>(GO_BACK_COMMAND, {
            request: {
                viewId,
                token: props.artifact.artifactHandleToken,
            },
        }).then((result) => {
            if (!active) return;
            callbacksRef.current.onNativeArtifactGoBackResult?.(readGoBackHandledResult(result) ?? false);
        }).catch(() => {
            if (active) callbacksRef.current.onNativeArtifactGoBackResult?.(false);
        });
        return () => {
            active = false;
        };
    }, [isOpen, props.artifact.artifactHandleToken, props.navigationCommand?.commandId, props.navigationCommand?.kind, viewId]);

    React.useEffect(() => {
        scheduleBoundsSync();
    }, [props.nativeArtifactLoadState, scheduleBoundsSync]);

    React.useEffect(() => {
        const globalEvents = globalThis as typeof globalThis & {
            ResizeObserver?: new (callback: () => void) => {
                observe: (target: unknown) => void;
                disconnect: () => void;
            };
        };
        const node = containerRef.current as unknown as NativeViewNode | null;
        const observer = node && globalEvents.ResizeObserver
            ? new globalEvents.ResizeObserver(scheduleBoundsSync)
            : null;
        if (node && observer) observer.observe(node as unknown as Element);
        globalEvents.addEventListener?.('resize', scheduleBoundsSync);
        return () => {
            observer?.disconnect();
            globalEvents.removeEventListener?.('resize', scheduleBoundsSync);
            const pending = pendingBoundsFrameRef.current;
            if (pending !== null) {
                pendingBoundsFrameRef.current = null;
                if (typeof globalEvents.cancelAnimationFrame === 'function') {
                    globalEvents.cancelAnimationFrame(pending as number);
                } else {
                    clearTimeout(pending as ReturnType<typeof setTimeout>);
                }
            }
        };
    }, [scheduleBoundsSync]);

    return (
        <View style={styles.root}>
            <View
                ref={containerRef}
                accessibilityElementsHidden={(props.nativeArtifactLoadState ?? 'loading') === 'loading'}
                importantForAccessibility={(props.nativeArtifactLoadState ?? 'loading') === 'loading' ? 'no-hide-descendants' : 'auto'}
                testID={props.testID}
                onLayout={scheduleBoundsSync}
                style={styles.frame}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    frame: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
});
