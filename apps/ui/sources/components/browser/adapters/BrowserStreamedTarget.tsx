import * as React from 'react';
import { Animated, Image, PixelRatio, Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type { BrowserEventBatchV1 } from '@happier-dev/protocol/browser/events/v1';
import { BrowserInputModifierV1Schema, type BrowserInputEventV1, type BrowserInteractionStateV1 } from '@happier-dev/protocol/browser/input/v1';

import { RemoteViewerStage, remoteViewerFillTransform, useRemoteViewerFillsPane, type RemoteViewerStageControls, type RemoteViewerHostActions } from '@/components/stream/RemoteViewerStage';
import { useRemoteViewerActions, type RemoteViewerKeyboard } from '@happier-dev/plugin-ui/presentation';
import { RemoteViewerControlBar } from '@/components/stream/RemoteViewerControlBar';
import type { RemoteViewerClipboardShortcut } from '@happier-dev/plugin-ui/presentation';
import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';
import { LiveStreamPlayer, type LiveStreamPlayerDisplayState } from '@/components/stream/LiveStreamPlayer';
import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { TextInput } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { BrowserDaemonControlDispatchClientResult } from '@/sync/domains/browser/control/machineRpc';

import { BrowserFrameStatusCapsule } from '../frame/BrowserFrameStatusCapsule';
import { BrowserPageInteractions } from '../streamed/BrowserPageInteractions';
import { readBrowserUploadFile } from '../streamed/browserUploadFiles';
import { BrowserSoftKeyboardButton } from '../streamed/BrowserSoftKeyboardButton';
import { useBrowserSoftKeyboard } from '../streamed/useBrowserSoftKeyboard';
import { useBrowserViewerViewport } from '../streamed/useBrowserViewerViewport';
import { buildBrowserStreamSidebandControl, buildBrowserViewerInput } from './browserStreamSidebandControl';
import { mapLiveStreamPointToContent } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';

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
    pictureFrame: {
        position: 'absolute',
    },
    inputOverlay: {
        ...StyleSheet.absoluteFillObject,
    },
    // A letterboxed page (another viewer's screen sets its size) keeps an edge of its own against the
    // inset around it, so the bars read as space outside the page, not as part of it.
    letterboxEdge: {
        position: 'absolute',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        pointerEvents: 'none',
    },
    // The phone keyboard's host: focusable and present (a hidden input cannot summon a keyboard), but
    // drawn nowhere a person sees it. It never holds the page's value.
    keyboardSentinel: {
        position: 'absolute',
        left: 0,
        bottom: 0,
        width: 1,
        height: 1,
        opacity: 0,
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
    /** The lifecycle owner's terminal cause survives retirement of the capture stream. */
    diagnosticCode?: string;
    /** The lifecycle reducer reports a crashed view or unavailable adapter. */
    terminal?: boolean;
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
const BROWSER_INPUT_KINDS: ReadonlySet<LiveStreamInputGesture['kind']> = new Set([
    'tap', 'swipe', 'drag', 'wheel', 'keyboard_text', 'keyboard_key',
]);
const supportsBrowserInput = (kind: LiveStreamInputGesture['kind']): boolean => BROWSER_INPUT_KINDS.has(kind);

/**
 * Where a `contain`-fitted frame of `frame` size is drawn inside `viewport`. `maxScale` caps the fit
 * (a picture that must not be drawn larger than its own pixels passes `1 / devicePixelRatio`).
 * `align: 'top'` keeps the frame against the top edge, as a page reads; `center` letterboxes evenly.
 */
export function containRect(
    viewport: Readonly<{ width: number; height: number }>,
    frame: Readonly<{ width: number; height: number }> | null,
    maxScale: number = Number.POSITIVE_INFINITY,
    align: 'center' | 'top' = 'center',
) {
    if (!frame || !(frame.width > 0 && frame.height > 0) || !(viewport.width > 0 && viewport.height > 0)) {
        return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    }
    const scale = Math.min(viewport.width / frame.width, viewport.height / frame.height, maxScale);
    const width = frame.width * scale;
    const height = frame.height * scale;
    return { x: (viewport.width - width) / 2, y: align === 'top' ? 0 : (viewport.height - height) / 2, width, height };
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

function StreamedPicture(props: Readonly<{
    stalled: boolean;
    /** Where the page is drawn once its shape is known; the player then fills exactly that rect. */
    frame: Readonly<{ left: number; top: number; width: number; height: number }> | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const opacity = usePictureOpacity(props.stalled);
    return <Animated.View style={[props.frame ? [stylesheet.pictureFrame, props.frame] : stylesheet.picture, { opacity }]}>{props.children}</Animated.View>;
}

/**
 * Where the page is drawn inside the live surface (px), for input mapping and the agent cursor, and the
 * page's own size (null until its first frame is measured; the rect is then the whole surface).
 */
export type BrowserStreamedPageRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    pageSize: Readonly<{ width: number; height: number }> | null;
}>;

function BrowserStreamInput(props: Readonly<{
    input: NonNullable<BrowserStreamedSurfaceRuntime['input']>;
    viewport: Readonly<{ width: number; height: number }>;
    content: BrowserStreamedPageRect;
    /** On a phone a tap also asks whether it landed in a field, so the keyboard can follow it. */
    probeEditable: boolean;
    controls: RemoteViewerStageControls;
    keyboard: RemoteViewerKeyboard;
    onRemoteActionsChange?: (actions: RemoteViewerHostActions | null) => void;
    testID: string;
}>): React.ReactElement {
    const { viewport, content, probeEditable } = props;
    const { send, sendInput, sourceId, streamId } = props.input;
    const sendGesture = React.useCallback((gesture: Readonly<{ eventId: string; action: LiveStreamInputGesture }>) => {
        const browserInput = buildBrowserViewerInput(gesture.action);
        if (browserInput && sendInput) { sendInput(browserInput); return; }
        const control = buildBrowserStreamSidebandControl({ sourceId, streamId, eventId: gesture.eventId, gesture: gesture.action });
        if (control) send(control);
        if (probeEditable && sendInput && control?.kind === 'tap') sendInput({ kind: 'editableProbe', x: control.x, y: control.y });
    }, [probeEditable, send, sendInput, sourceId, streamId]);
    const actionSequence = React.useRef(0);
    const sendAction = React.useCallback((action: LiveStreamInputGesture) => sendGesture({eventId: `viewer:${Date.now()}:${++actionSequence.current}`, action}), [sendGesture]);
    const controlling = props.input.viewerInput?.controlling === true;
    const onFileDrop = React.useCallback((files: readonly File[], point: Readonly<{ x: number; y: number }>) => {
        if (!sendInput) return;
        // Use the same picture/content projection as pointer input (including local zoom).
        const target = mapLiveStreamPointToContent({ point, viewport, content });
        if (!target) return;
        void Promise.all(files.map(readBrowserUploadFile)).then(files => {
            sendInput({ kind: 'fileDrop', ...target, files });
        }).catch(() => undefined);
    }, [sendInput, viewport, content]);
    const actions = useRemoteViewerActions({enabled: controlling, sendGesture: sendAction, clipboardShortcut: props.input.clipboardShortcut,
        keyboard: props.keyboard, supportedModifiers: BrowserInputModifierV1Schema.options});
    const onGesture = React.useCallback((gesture: Readonly<{eventId: string; action: LiveStreamInputGesture}>) => {
        const action = !controlling || (gesture.action.kind === 'pointer' && gesture.action.phase === 'cancel') ? gesture.action : actions.prepareGesture(gesture.action);
        if (action) sendGesture({...gesture, action});
    }, [actions.prepareGesture, controlling, sendGesture]);
    const supports = React.useCallback((kind: LiveStreamInputGesture['kind']) => kind === 'move' ? controlling
        : kind === 'pointer' ? controlling && Boolean(sendInput) : supportsBrowserInput(kind), [controlling, sendInput]);
    const published = React.useMemo(() => ({...actions, inputMode: {value: props.controls.mode, setMode: props.controls.setMode},
        resetZoom: props.controls.resetZoom}), [actions, props.controls.mode, props.controls.setMode, props.controls.resetZoom]);
    const publishActions = React.useRef(props.onRemoteActionsChange);
    publishActions.current = props.onRemoteActionsChange;
    React.useEffect(() => { publishActions.current?.(published); return () => publishActions.current?.(null); }, [published]);
    return (
        <View style={stylesheet.inputOverlay}>
            <LiveStreamInputLayer
                inputAccepted
                supports={supports}
                mode={props.controls.mode}
                localZoom
                zoomReset={props.controls.zoomReset}
                restTransform={props.controls.restTransform}
                dragPansView={props.controls.dragPansView}
                onViewTransformChange={props.controls.onViewTransformChange}
                renderCursor={props.controls.renderCursor}
                renderDragTrail={props.controls.renderDragTrail}
                viewport={viewport}
                content={content}
                onGesture={onGesture}
                onClipboardShortcut={props.input.clipboardShortcut}
                onFileDrop={onFileDrop}
                accessibilityLabel={t('browserPresence.stream.inputA11y')}
                testID={props.testID}
            />
            <RemoteViewerControlBar actions={published} controls={props.controls} enabled={controlling} testID={`${props.testID}-controls`} />
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
    onRemoteActionsChange?: (actions: RemoteViewerHostActions | null) => void;
    agentName: string;
    /** No agent resolves: the connecting title names none. */
    agentless?: boolean;
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
    const surfaceState = props.runtime?.terminal ? 'unavailable' : resolveBrowserStreamedSurfaceState(playerState);
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
    const input = props.runtime?.input ?? null;
    // The daemon's applied page size is the page's shape once it is known (the controlling viewer may
    // have resized it since the first frame); the first frame stands in until then.
    const pageShape = input?.viewport ?? frameSize;
    // A page someone else sized reads like a page: across the pane, from the top. Below it the inset stays;
    // the page itself scrolls through the forwarded wheel and swipe, so the pane needs no scroller of its own.
    const pageRect = pictureUp && viewport ? { ...containRect(viewport, pageShape, Number.POSITIVE_INFINITY, 'top'), pageSize: frameSize } : null;
    const controlling = input?.viewerInput?.controlling === true;
    const sendInput = input?.sendInput;
    // The controlling viewer's screen sets the page's size; everyone else letterboxes it.
    useBrowserViewerViewport({
        controlling: controlling && Boolean(sendInput),
        viewport: viewport ? { width: Math.round(viewport.width), height: Math.round(viewport.height), deviceScaleFactor: PixelRatio.get() } : null,
        sendViewport: next => sendInput?.({ kind: 'viewport', ...next }),
    });
    const phone = useSurfaceStateSize() === 'phone';
    const viewerActions = React.useRef<RemoteViewerHostActions | null>(null);
    const onRemoteActionsChange = React.useCallback((actions: RemoteViewerHostActions | null) => {
        viewerActions.current = actions;
        props.onRemoteActionsChange?.(actions);
    }, [props.onRemoteActionsChange]);
    const keyboard = useBrowserSoftKeyboard({
        enabled: phone && controlling && Boolean(sendInput),
        target: input?.editableTarget ?? null,
        sendText: text => viewerActions.current?.sendText(text),
        sendKey: key => viewerActions.current?.sendKey(key),
    });
    const keyboardActions = React.useMemo(() => ({available: keyboard.available, focused: keyboard.focused,
        showKeyboard: keyboard.showKeyboard, hideKeyboard: keyboard.hideKeyboard}),
        [keyboard.available, keyboard.focused, keyboard.showKeyboard, keyboard.hideKeyboard]);
    // On a phone a viewer who only watches sees the page fill the pane (the stage owns that view); the remote
    // page keeps the size its controller gave it.
    const fillsPane = useRemoteViewerFillsPane(!controlling);
    const letterboxed = !fillsPane && pageRect !== null && viewport !== null
        && (pageRect.width < viewport.width - 1 || pageRect.height < viewport.height - 1);
    const otherViewerControls = props.humanInControl === true && !controlling;
    const onPageRectChange = props.onPageRectChange;
    React.useEffect(() => {
        // The Agent's cursor is drawn over the page where it rests: filled on a passive phone, whole elsewhere.
        // A viewer's own pan or pinch moves only the picture (as local zoom always has).
        const view = fillsPane && pageRect && viewport ? remoteViewerFillTransform(viewport, pageRect, pageShape ?? pageRect) : null;
        onPageRectChange?.(view && pageRect ? { ...pageRect, x: pageRect.x * view.scale + view.x, y: pageRect.y * view.scale + view.y,
            width: pageRect.width * view.scale, height: pageRect.height * view.scale } : pageRect);
    }, [onPageRectChange, fillsPane, viewport, pageRect?.x, pageRect?.y, pageRect?.width, pageRect?.height, frameSize, pageShape?.width, pageShape?.height]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => () => onPageRectChange?.(null), [onPageRectChange]);

    if (surfaceState === 'connecting' || (props.runtime?.connecting && !props.runtime.terminal && surfaceState === 'unavailable')) {
        return (
            <BrowserStreamedConnecting
                testID={`${props.testID}-connecting`}
                title={props.agentless ? t('browserPresence.stream.connectingTitleAgentless') : t('browserPresence.stream.connectingTitle', { agent: props.agentName })}
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
                    title={props.agentless ? t('browserPresence.stream.endedTitleAgentless') : t('browserPresence.stream.endedTitle', { agent: props.agentName })}
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
                    title={props.runtime?.terminal ? t('browserPresence.stream.stoppedTitle') : props.agentless ? t('browserPresence.stream.unavailableTitleAgentless') : t('browserPresence.stream.unavailableTitle', { agent: props.agentName })}
                    reason={props.runtime?.terminal ? t('browserPresence.stream.endedBody') : props.agentless ? t('browserPresence.stream.unavailableBodyAgentless') : t('browserPresence.stream.unavailableBody', { agent: props.agentName })}
                    diagnosticCode={props.runtime?.diagnosticCode ?? playerState?.diagnostic?.reasonCode}
                    action={onRetry ? { label: t('browserPresence.stream.tryAgain'), onPress: onRetry } : undefined}
                />
            </View>
        );
    }
    return (
        <View testID={`${props.testID}-${surfaceState}`} style={stylesheet.root} onLayout={onLayout}>
            <RemoteViewerStage key={input?.viewerKey} viewerKey={input?.viewerKey} viewport={viewport ?? {width: 1, height: 1}}
                content={pageRect} pictureSize={pageShape} passive={!controlling}
                enabled={Boolean(input && viewport && pageRect && surfaceState === 'live')}
                testID={props.testID} renderInput={controls => input && viewport && pageRect && surfaceState === 'live' ? (
                    <BrowserStreamInput input={input} viewport={viewport} content={pageRect} controls={controls} keyboard={keyboardActions}
                        onRemoteActionsChange={onRemoteActionsChange} probeEditable={phone} testID={`${props.testID}-input`} />
                ) : null}>
            <StreamedPicture stalled={surfaceState === 'stalled'}
                frame={pageRect && pageShape ? { left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height } : null}>
                <LiveStreamPlayer
                    testID={`${props.testID}-player`}
                    state={playerState}
                    statusOwnedByHost
                    avcc={playerState.avccChunks && playerState.avccChunks.length > 0
                        ? { chunks: playerState.avccChunks }
                        : undefined}
                />
            </StreamedPicture>
            {letterboxed && pageRect ? <View style={[stylesheet.letterboxEdge, {left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height}]}
                testID={`${props.testID}-letterbox`} /> : null}
            </RemoteViewerStage>
            {phone && controlling && sendInput ? (
                <TextInput ref={keyboard.inputRef} {...keyboard.sentinelProps} style={stylesheet.keyboardSentinel}
                    accessibilityLabel={t('browserPresence.interaction.showKeyboard')} testID={`${props.testID}-keyboard-sentinel`} />
            ) : null}
            <BrowserSoftKeyboardButton
                visible={keyboard.available && !keyboard.focused}
                onPress={keyboard.showKeyboard}
                testID={`${props.testID}-keyboard`}
            />
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
