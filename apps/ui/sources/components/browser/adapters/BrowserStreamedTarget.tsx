import type { BrowserEventBatchV1 } from '@happier-dev/protocol/browser/events/v1';
import type { BrowserInputEventV1, BrowserInteractionStateV1 } from '@happier-dev/protocol/browser/input/v1';
import { BrowserPageInteractions } from '../streamed/BrowserPageInteractions';
import * as React from 'react';
import type { RemoteViewerClipboardShortcut } from '@/components/stream/remoteViewerClipboard';
import { Animated, Image, Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineLiveStreamControlSidebandV1, MachineLiveStreamInputControlKindV1 } from '@happier-dev/protocol';

import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';
import { LiveStreamPlayer, type LiveStreamPlayerDisplayState } from '@/components/stream/LiveStreamPlayer';
import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { BrowserDaemonControlDispatchClientResult } from '@/sync/domains/browser/control/machineRpc';

import { BrowserFrameStatusCapsule } from '../frame/BrowserFrameStatusCapsule';
import { buildBrowserStreamSidebandControl } from './browserStreamSidebandControl';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.inset,
    },
    picture: {
        flex: 1,
        minHeight: 0,
    },
    inputOverlay: {
        ...StyleSheet.absoluteFillObject,
    },
}));

/**
 * The live picture of a browser that runs somewhere else — the agent's managed Chromium on a
 * machine — as the stream consumer sees it. One capture source (kind `browser`, family
 * `browser.streamed`, keyed by the view) feeds it; the daemon owns the producer.
 */
export type BrowserStreamedSurfaceRuntime = Readonly<{
    /** Where the browser runs, for honest copy ("It runs on MacBook Pro"). */
    machineName: string | null;
    /** The player's state for this view's stream, or null when no stream could be opened. */
    playerState: (LiveStreamPlayerDisplayState & Readonly<{ avccChunks?: readonly Uint8Array[] }>) | null;
    /** The view's source is known and the stream is opening (no frame yet). */
    connecting?: boolean;
    /** The discovery owner's typed prerequisite/failure, distinct from a stream failure. */
    unavailableReason?: Extract<BrowserDaemonControlDispatchClientResult, { ok: false }>['reason'];
    /** Try to open the stream again after it failed. */
    onRetry?: () => void;
    /**
     * Where the agent's first open stands before its page can be streamed, read from the typed Machine
     * Action operation and the discovery owner: `preparing` (the Machine is downloading Chromium),
     * `opening` (the open went through; the page is on its way), `installFailed`, `sandboxUnavailable`.
     */
    firstUse?: 'preparing' | 'opening' | 'installFailed' | 'sandboxUnavailable';
    /** The page the agent asked for while its browser is preparing or opening: the chrome's address shows it. */
    firstUseTargetUrl?: string;
    /**
     * Viewer input back to the registered source: tap, scroll and typing reach the page, and the
     * daemon turns them into a human takeover. Absent when the source accepts no input.
     */
    input?: Readonly<{
        viewerKey?: string;
        sourceId: string;
        streamId: string;
        send: (control: MachineLiveStreamControlSidebandV1) => void;
        viewport?: BrowserEventBatchV1['viewport'] | null;
        viewerInput?: BrowserEventBatchV1['viewerInput'] | null;
        editableTarget?: BrowserEventBatchV1['editableTarget'] | null;
        /** The page's open dialog, file request and downloads, as the daemon last projected them. */
        interaction?: BrowserInteractionStateV1 | null;
        /** Answers the page as this viewer at the admitted control epoch; absent until one is known. */
        sendInput?: (event: BrowserViewerInputEvent) => void;
        /** Fetches a finished download's bytes and saves them on this device; absent where it cannot. */
        saveDownload?: (downloadId: string) => void;
        /** Focused controlling-viewer clipboard intent; never encoded as a letter key. */
        clipboardShortcut?: RemoteViewerClipboardShortcut;
    }> | null;
}>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A human page input before the runtime stamps its target and sequence. */
export type BrowserViewerInputEvent = DistributiveOmit<BrowserInputEventV1, 'target' | 'sequence'>;

/** The gestures a browser source turns into page input (tap, scroll, typed text, keys). */
const BROWSER_INPUT_KINDS: ReadonlySet<MachineLiveStreamInputControlKindV1> = new Set([
    'tap', 'swipe', 'keyboard_text', 'keyboard_key',
]);
const supportsBrowserInput = (kind: MachineLiveStreamInputControlKindV1): boolean => BROWSER_INPUT_KINDS.has(kind);

/**
 * Where a `contain`-fitted frame of `frame` size is drawn inside `viewport`. `maxScale` caps the fit
 * (a picture that must not be drawn larger than its own pixels passes `1 / devicePixelRatio`).
 */
export function containRect(
    viewport: Readonly<{ width: number; height: number }>,
    frame: Readonly<{ width: number; height: number }> | null,
    maxScale: number = Number.POSITIVE_INFINITY,
) {
    if (!frame || !(frame.width > 0 && frame.height > 0) || !(viewport.width > 0 && viewport.height > 0)) {
        return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    }
    const scale = Math.min(viewport.width / frame.width, viewport.height / frame.height, maxScale);
    const width = frame.width * scale;
    const height = frame.height * scale;
    return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

/** A kept last frame is not the live page: it recedes while the status capsule says why (lab ST). */
const STALE_PICTURE_OPACITY = 0.72;

/**
 * The picture's presence: the first frame fades up out of the connecting card instead of popping in,
 * and a kept last frame recedes and returns on the standard curve. Reduced motion: it simply shows.
 */
function usePictureOpacity(stalled: boolean): Animated.Value {
    const reducedMotion = useReducedMotionPreference();
    const opacity = React.useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
    const target = stalled ? STALE_PICTURE_OPACITY : 1;
    React.useEffect(() => {
        if (reducedMotion) {
            opacity.setValue(target);
            return;
        }
        Animated.timing(opacity, {
            toValue: target,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [opacity, reducedMotion, target]);
    return opacity;
}

/**
 * The page's natural size, read once per (re)connection from the first frame it shows — the page is
 * re-measured when the stream reopens, not decoded on every frame. A view that opens on a kept last
 * frame (a stalled stream) is measured from that frame, so the cursor and input map from the start.
 */
export function useFirstFrameSize(frameUrl: string | null | undefined, phase: string | undefined) {
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const live = phase === 'playing' || phase === 'degraded';
    const measuredRef = React.useRef(false);
    React.useEffect(() => {
        // Leaving the live phase ends this connection: its next first frame is measured again.
        if (!live) measuredRef.current = false;
    }, [live]);
    React.useEffect(() => {
        if (!frameUrl || measuredRef.current) return;
        measuredRef.current = true;
        Image.getSize(frameUrl, (width, height) => setSize({ width, height }), () => undefined);
    }, [frameUrl, live]);
    return size;
}

/**
 * The Connecting state (lab `browser` ST): a calm ring that names where the browser runs. Every wait
 * before the first frame draws this one card, whether the stream is opening or the Machine is still
 * preparing its browser, so the page never swaps presentation while it comes up.
 */
export function BrowserStreamedConnecting(props: Readonly<{ testID: string; title: string; reason?: string }>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.root}>
            <SurfaceStateCard kind="loading" title={props.title} reason={props.reason} />
        </View>
    );
}

function StreamedPicture(props: Readonly<{ stalled: boolean; children: React.ReactNode }>): React.ReactElement {
    const opacity = usePictureOpacity(props.stalled);
    return <Animated.View style={[stylesheet.picture, { opacity }]}>{props.children}</Animated.View>;
}

/** Where the page is drawn inside the live surface (px), for input mapping and the agent cursor. */
export type BrowserStreamedPageRect = Readonly<{ x: number; y: number; width: number; height: number }>;

function BrowserStreamInput(props: Readonly<{
    input: NonNullable<BrowserStreamedSurfaceRuntime['input']>;
    viewport: Readonly<{ width: number; height: number }>;
    content: BrowserStreamedPageRect;
    testID: string;
}>): React.ReactElement {
    const { viewport, content } = props;
    const { send, sourceId, streamId } = props.input;
    const onGesture = React.useCallback((gesture: Readonly<{ eventId: string; action: LiveStreamInputGesture }>) => {
        const control = buildBrowserStreamSidebandControl({ sourceId, streamId, eventId: gesture.eventId, gesture: gesture.action });
        if (control) send(control);
    }, [send, sourceId, streamId]);
    return (
        <View style={stylesheet.inputOverlay}>
            <LiveStreamInputLayer
                inputAccepted
                supports={supportsBrowserInput}
                viewport={viewport}
                content={content}
                onGesture={onGesture}
                onClipboardShortcut={props.input.clipboardShortcut}
                accessibilityLabel={t('browserPresence.stream.inputA11y')}
                testID={props.testID}
            />
        </View>
    );
}

type StreamSurfaceState =
    | 'unavailable'
    | 'connecting'
    | 'live'
    | 'stalled'
    | 'ended';

function hasRenderableFrame(state: BrowserStreamedSurfaceRuntime['playerState']): boolean {
    if (!state) return false;
    return (typeof state.lastFrameUrl === 'string' && state.lastFrameUrl.length > 0)
        || (state.avccChunks?.length ?? 0) > 0;
}

/**
 * The honest state of the agent's streamed browser (lab `browser` ST). Never "playing" without a
 * frame: no frame yet is `connecting`; a frame kept while the stream recovers is `stalled`; the
 * producer stopping is `ended`; a stream that cannot be opened is `unavailable`.
 */
export function resolveBrowserStreamedSurfaceState(state: BrowserStreamedSurfaceRuntime['playerState']): StreamSurfaceState {
    if (!state) return 'unavailable';
    const frame = hasRenderableFrame(state);
    switch (state.phase) {
        case 'stopped':
            return 'ended';
        case 'error':
            return frame ? 'stalled' : 'unavailable';
        case 'reconnecting':
            return frame ? 'stalled' : 'connecting';
        case 'idle':
        case 'opening':
            return frame ? 'live' : 'connecting';
        case 'playing':
        case 'degraded':
            return frame ? 'live' : 'connecting';
    }
}

/**
 * Renders the agent's streamed browser view through the canonical `LiveStreamPlayer` (the one
 * decoder/renderer the simulator already uses), with one status capsule while the picture is not
 * live, and a designed card for connecting, ended and unavailable. The presence capsule (who drives
 * the page, Take control) is the shell's and sits above this, so it stays reachable in every state
 * here, including a stalled decoder.
 */
export function BrowserStreamedTarget(props: Readonly<{
    runtime: BrowserStreamedSurfaceRuntime | null;
    agentName: string;
    onOpenPageHere?: () => void;
    onClosePage?: () => void;
    /**
     * Where the page is drawn while the picture is up (`null` otherwise). The frame is fitted with
     * `contain`, so the agent cursor and viewer input both map through this one rect.
     */
    onPageRectChange?: (rect: BrowserStreamedPageRect | null) => void;
    /** The page's host for the page's own dialogs ("localhost:5173 says"). */
    pageHost?: string | null;
    /** A person is driving the page; when that is not this viewer, another viewer answers the page. */
    humanInControl?: boolean;
    testID: string;
}>): React.ReactElement {
    const playerState = props.runtime?.playerState ?? null;
    const surfaceState = resolveBrowserStreamedSurfaceState(playerState);
    const machineName = props.runtime?.machineName ?? null;
    const pictureUp = surfaceState === 'live' || surfaceState === 'stalled';
    const [viewport, setViewport] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) {
            setViewport((current) => (current && current.width === width && current.height === height ? current : { width, height }));
        }
    }, []);
    // The page's natural size is read only when something maps through it (viewer input, the cursor).
    const wantsPageRect = Boolean(props.runtime?.input) || Boolean(props.onPageRectChange);
    const frameSize = useFirstFrameSize(pictureUp && wantsPageRect ? playerState?.lastFrameUrl : null, playerState?.phase);
    const pageRect = pictureUp && viewport ? containRect(viewport, frameSize) : null;
    const input = props.runtime?.input ?? null;
    const controlling = input?.viewerInput?.controlling === true;
    const sendInput = input?.sendInput;
    const otherViewerControls = props.humanInControl === true && !controlling;
    const onPageRectChange = props.onPageRectChange;
    React.useEffect(() => {
        onPageRectChange?.(pageRect);
    }, [onPageRectChange, pageRect?.x, pageRect?.y, pageRect?.width, pageRect?.height]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => () => onPageRectChange?.(null), [onPageRectChange]);

    if (surfaceState === 'connecting' || (props.runtime?.connecting && surfaceState === 'unavailable')) {
        return (
            <BrowserStreamedConnecting
                testID={`${props.testID}-connecting`}
                title={t('browserPresence.stream.connectingTitle', { agent: props.agentName })}
                reason={machineName ? t('browserPresence.stream.connectingBody', { machine: machineName }) : undefined}
            />
        );
    }
    if (surfaceState === 'ended') {
        return (
            <View testID={`${props.testID}-ended`} style={stylesheet.root}>
                <SurfaceStateCard
                    kind="unavailable"
                    iconName="browsers"
                    title={t('browserPresence.stream.endedTitle', { agent: props.agentName })}
                    reason={t('browserPresence.stream.endedBody')}
                    action={props.onOpenPageHere ? { label: t('browserPresence.stream.openPageHere'), onPress: props.onOpenPageHere,
                        testID: `${props.testID}-ended-open` } : undefined}
                    secondaryAction={props.onClosePage ? { label: t('session.detailsPanel.closeTabA11y'), onPress: props.onClosePage,
                        testID: `${props.testID}-ended-close` } : undefined}
                />
            </View>
        );
    }
    if (surfaceState === 'unavailable' || !playerState) {
        const onRetry = props.runtime?.onRetry;
        return (
            <View testID={`${props.testID}-unavailable`} style={stylesheet.root}>
                <SurfaceStateCard
                    kind="unavailable"
                    iconName="eye-slash"
                    title={t('browserPresence.stream.unavailableTitle', { agent: props.agentName })}
                    reason={t('browserPresence.stream.unavailableBody', { agent: props.agentName })}
                    diagnosticCode={playerState?.diagnostic?.reasonCode}
                    action={onRetry ? { label: t('browserPresence.stream.tryAgain'), onPress: onRetry } : undefined}
                />
            </View>
        );
    }
    return (
        <View testID={`${props.testID}-${surfaceState}`} style={stylesheet.root} onLayout={onLayout}>
            <StreamedPicture stalled={surfaceState === 'stalled'}>
                <LiveStreamPlayer
                    testID={`${props.testID}-player`}
                    state={playerState}
                    statusOwnedByHost
                    avcc={playerState.avccChunks && playerState.avccChunks.length > 0
                        ? { chunks: playerState.avccChunks }
                        : undefined}
                />
            </StreamedPicture>
            {props.runtime?.input && viewport && pageRect ? (
                <BrowserStreamInput
                    input={props.runtime.input}
                    viewport={viewport}
                    content={pageRect}
                    testID={`${props.testID}-input`}
                />
            ) : null}
            {input ? (
                <BrowserPageInteractions
                    interaction={input.interaction}
                    pageHost={props.pageHost ?? null}
                    answer={otherViewerControls ? undefined : sendInput}
                    onSaveDownload={input.saveDownload ? download => input.saveDownload?.(download.downloadId) : undefined}
                    testID={`${props.testID}-interaction`}
                />
            ) : null}
            <BrowserFrameStatusCapsule
                visible={surfaceState === 'stalled'}
                testID={`${props.testID}-stalled`}
                text={t('browserPresence.stream.stalled')}
                busy
            />
        </View>
    );
}
