import { setDesktopGlassPanelShape } from '@/utils/platform/desktopGlassMaterial';
import * as React from 'react';
import { View } from 'react-native';
import { ScopedTheme, StyleSheet } from 'react-native-unistyles';

import { createActivitySurfaceSessionTarget } from '@/activity/actions/activitySurfaceTargets';
import {
    emitDesktopActivityOverlayInteraction,
    enterDesktopActivityOverlayPointer,
    executeDesktopActivityOverlayInteractionWithResult,
    listenDesktopActivityOverlayPointer,
    listenDesktopActivityOverlayPresentation,
    presentDesktopActivityOverlay,
    type DesktopActivityOverlayFrame,
    type DesktopActivityOverlayWindowStatePayload,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useDesktopActivityOverlayField, useDesktopActivityOverlayFieldPresent } from '@/activity/adapters/desktop/runtime/useDesktopActivityOverlayState';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { Text } from '@/components/ui/text/Text';
import { measureRectInContainer, RectFlightLayer, unionFlightRects, useRectFlight, type FlightRect } from '@/components/ui/motion/rectFlight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    DesktopActivityOverlayCollapsed,
    DesktopActivityOverlaySideWordTab,
    DesktopActivityOverlayStatusHeader,
    type DesktopActivityOverlayCollapsedPressOrigin,
    type DesktopActivityOverlayStatusSlots,
    type DesktopActivityOverlayStatusWord,
} from './DesktopActivityOverlayCollapsed';
import { DesktopActivityOverlayListPanel } from './DesktopActivityOverlayListPanel';
import { DesktopActivityOverlayPinnedPanel } from './conversation/DesktopActivityOverlayPinnedPanel';
import {
    DesktopActivityOverlayFaces,
    type NotchBotHandlers,
    type NotchBotOpenPresentation,
} from './faces/DesktopActivityOverlayFaces';
import type { BotFaceSnapshot } from '../presentation/notchBotTypes';
import { composeDesktopActivityOverlayAccessibilityLabel } from './desktopActivityOverlayAccessibilityLabel';
import { NotchShape, type NotchPresentFrame } from './notch/NotchShape';
import {
    type NotchCameraBlock,
    type NotchDock,
    type NotchForm,
} from './notch/notchShapeGeometry';
import {
    createNotchPresentation,
    notchPresentationDelay,
    reduceNotchPresentation,
    type NotchPresentationEvent,
    type NotchPresentationFacts,
    type NotchPresentationState,
    type NotchSurface,
} from './presentation/notchPresentation';
import type { DesktopActivityOverlayActionHandler, DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';
import { useDesktopOverlayTransparentDocumentBackground } from './useDesktopOverlayTransparentDocumentBackground';

type PlacementDiagnostics = DesktopActivityOverlayWindowStatePayload['placementDiagnostics'];

/**
 * Native frames the window from the first `present`, so before then the island lays out as its dock
 * naturally grows (away from the edge, centred along it). From the first frame on, native's `frame`
 * (2D growth toward the display centre, anchor offset after clamping) is the only placement fact.
 */
function preFramePlacement(dock: NotchDock): Pick<DesktopActivityOverlayFrame, 'growth' | 'anchorOffset'> {
    return {
        growth: dock === 'left' ? { x: 'right', y: null } : dock === 'right' ? { x: 'left', y: null } : { x: null, y: 'down' },
        anchorOffset: { x: 0, y: 0 },
    };
}

/** Windows: WebView2 reports entry on the shape itself; native raw input supplies the exit. */
function onShapePointerEnter() {
    fireAndForget(enterDesktopActivityOverlayPointer(), { tag: 'DesktopActivityOverlayRoute.pointerEnter' });
}

function emitInteraction(actionIdentifier: string, data: Record<string, unknown> = {}) {
    fireAndForget(
        emitDesktopActivityOverlayInteraction({ actionIdentifier, data }),
        { tag: `DesktopActivityOverlayRoute.emitInteraction.${actionIdentifier}` },
    );
}

function withOptionalServerId(data: Record<string, unknown>, serverId: string | null | undefined): Record<string, unknown> {
    return serverId ? { ...data, serverId } : data;
}


/** `session.open` outcomes that mean the Session is now in a window (N4). */
function isWindowOpened(result: unknown): boolean {
    return Boolean(result && typeof result === 'object' && 'status' in result
        && ((result as { status?: unknown }).status === 'opened' || (result as { status?: unknown }).status === 'focused'));
}

/** The opened window's frame in logical screen pixels (N4's `rect`), when the result carries one. */
function readOpenedWindowRect(result: unknown): FlightRect | null {
    const rect = result && typeof result === 'object' && 'rect' in result ? (result as { rect?: unknown }).rect : null;
    if (!rect || typeof rect !== 'object') return null;
    const { x, y, width, height } = rect as Record<string, unknown>;
    return [x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))
        ? { x: x as number, y: y as number, w: width as number, h: height as number } : null;
}

/** The visual size class of a presentation state; the reducer alone decides the state. */
function resolveNotchForm(surface: NotchSurface): NotchForm {
    if (surface === 'tip' || surface === 'camera_tip') return 'tip';
    if (surface === 'expanded' || surface === 'pinned') return 'open';
    return 'standard';
}

function readDock(frame: DesktopActivityOverlayFrame | null | undefined, policy: DesktopOverlayPolicy): NotchDock {
    return frame?.dock ?? policy.dock;
}

/** The measured camera block when the island sits in a MacBook camera notch (Top on the built-in display). */
function readCameraBlock(diagnostics: PlacementDiagnostics | null, dock: NotchDock): NotchCameraBlock | null {
    if (dock !== 'top') return null;
    const context = diagnostics?.displayContext;
    const size = context?.physicalNotchSize;
    if (!context?.hasPhysicalNotch || !context.isBuiltinDisplay || !size) return null;
    return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
}

/** The island's one status word: N1's shared activity word ("Needs you", "2 working" or empty). */
function readStatusWord(collapsed: DesktopActivityOverlayUiModel['collapsed'] | null): DesktopActivityOverlayStatusWord | null {
    const text = collapsed?.title;
    if (!text) return null;
    return { text, needsYou: collapsed.activity === 'needsYou' };
}

export function DesktopActivityOverlayRoute(): React.ReactElement {
    // The island reads the field leaves it renders: a detail update never republishes the word.
    const policy = useDesktopActivityOverlayField('policy');
    const inOverlayWindowContext = isDesktopActivityOverlayWindowContext();
    useDesktopOverlayTransparentDocumentBackground(inOverlayWindowContext);

    if (!inOverlayWindowContext || !policy) {
        return inOverlayWindowContext ? (
            <View testID="desktop-activity-overlay-loading" style={styles.loadingContainer}>
                <Text style={styles.loadingText}>{t('common.loading')}</Text>
            </View>
        ) : <View testID="desktop-activity-overlay-hidden" style={styles.hiddenContainer} />;
    }

    return <DesktopActivityOverlayIsland policy={policy} />;
}

function DesktopActivityOverlayIsland(props: Readonly<{ policy: DesktopOverlayPolicy }>): React.ReactElement {
    const { policy } = props;
    const visible = useDesktopActivityOverlayField('visible') === true;
    const collapsed = useDesktopActivityOverlayField('word');
    const blockingCard = useDesktopActivityOverlayField('blockingCard') === true;
    const faces = useDesktopActivityOverlayField('faces');
    // The pinned slice's content is the pinned panel leaf's; the island only lays out whether one exists.
    const hasConversation = useDesktopActivityOverlayFieldPresent('conversation');
    const frame = useDesktopActivityOverlayField('frame');
    const screenOrigin = useDesktopActivityOverlayField('screenOrigin') ?? null;
    const screenOriginRef = React.useRef(screenOrigin);
    screenOriginRef.current = screenOrigin;
    const reducedMotion = useReducedMotionPreference();
    const rootRef = React.useRef<View | null>(null);
    // Extract's flight (N3 U3 on the N2 flight seam): screen-space endpoints, the window origin at take-off,
    // and the layer bounds native keeps in the envelope until the panel lands.
    const extractFlight = useRectFlight();
    const [flight, setFlight] = React.useState<Readonly<{ origin: { x: number; y: number }; size: { w: number; h: number } }> | null>(null);
    const flightBoundsRef = React.useRef<FlightRect | null>(null);
    const lastPresentFrameRef = React.useRef<NotchPresentFrame | null>(null);
    const placementDiagnostics = useDesktopActivityOverlayField('placementDiagnostics') ?? null;
    const dock = readDock(frame, policy);
    const camera = readCameraBlock(placementDiagnostics, dock);
    // The reply lives in the pinned conversation (owner ruling 13): its field owns its text, and the island
    // keeps only whether it holds text (the draft lock). Refs answer event-time decisions: a key handler
    // must see the character just typed.
    const pinnedDraftDirtyRef = React.useRef(false);
    const [pinnedDraftDirty, setPinnedDraftDirty] = React.useState(false);
    const hasConversationRef = React.useRef(hasConversation);
    hasConversationRef.current = hasConversation;
    const collapsedTriggerRef = React.useRef<View | null>(null);
    const expandedSurfaceRef = React.useRef<View | null>(null);
    const expandedFocusTargetRef = React.useRef<View | null>(null);
    const expandedFocusWithinRef = React.useRef(false);
    const keyboardExpandPendingRef = React.useRef(false);
    const collapsedFocusReturnPendingRef = React.useRef(false);

    const facts: NotchPresentationFacts = {
        enabled: policy.enabled,
        visible,
        idle: policy.idle,
        cameraNotch: camera !== null,
        hoverExpandDelayMs: policy.hoverExpandDelayMs,
        draftLocked: hasConversation && pinnedDraftDirty,
        focusWithin: false,
        blockingCard,
    };
    // Facts are read when an event lands; focus-within is tracked without rendering.
    const factsRef = React.useRef(facts);
    factsRef.current = facts;
    const readFacts = React.useCallback((): NotchPresentationFacts => ({
        ...factsRef.current,
        focusWithin: expandedFocusWithinRef.current,
    }), []);

    const [presentation, setPresentation] = React.useState<NotchPresentationState>(() => createNotchPresentation(facts));
    const dispatch = React.useCallback((event: NotchPresentationEvent) => {
        setPresentation((previous) => reduceNotchPresentation(previous, event, readFacts()));
    }, [readFacts]);

    const factsKey = [facts.enabled, facts.visible, facts.idle, facts.cameraNotch, facts.hoverExpandDelayMs, facts.draftLocked, facts.blockingCard].join(':');
    React.useEffect(() => {
        dispatch({ type: 'facts', facts: readFacts() });
    }, [dispatch, factsKey, readFacts]);

    // The reducer's one pending decision (hover dwell or leave delay) is a one-shot timer.
    const pendingDelayMs = notchPresentationDelay(presentation, facts);
    React.useEffect(() => {
        if (pendingDelayMs === null || presentation.pending === null) return;
        const event = presentation.pending === 'dwell' ? 'dwell' : 'leaveElapsed';
        const timeoutId = setTimeout(() => dispatch({ type: event }), pendingDelayMs);
        return () => clearTimeout(timeoutId);
    }, [dispatch, pendingDelayMs, presentation.pending]);

    // `desktop.notch.set` (a person's or an agent's) arrives as one presentation request; the reducer
    // applies it like any other input, and a focused request hands focus to the panel's first control.
    React.useEffect(() => {
        let dispose: (() => void) | null = null;
        let disposed = false;
        void listenDesktopActivityOverlayPresentation((request) => {
            if (request.focus && request.state !== 'rest') keyboardExpandPendingRef.current = true;
            dispatch({ type: 'set', state: request.state });
        }).then((unlisten) => {
            if (disposed) unlisten();
            else dispose = unlisten;
        }).catch(() => {});
        return () => {
            disposed = true;
            dispose?.();
        };
    }, [dispatch]);

    // Native pointer adapters report crossings and outside presses; nothing is polled.
    React.useEffect(() => {
        let dispose: (() => void) | null = null;
        let disposed = false;
        void listenDesktopActivityOverlayPointer((pointer) => {
            dispatch({ type: pointer.kind });
        }).then((unlisten) => {
            if (disposed) unlisten();
            else dispose = unlisten;
        }).catch(() => {});
        return () => {
            disposed = true;
            dispose?.();
        };
    }, [dispatch]);

    const form = resolveNotchForm(presentation.surface);
    const open = form === 'open';

    // Every input reaches the reducer; its committed presentation owns detail demand.
    // A pin exit also releases the target, including Back into the still-open overview.
    const previousSurfaceRef = React.useRef(presentation.surface);
    React.useEffect(() => {
        const previous = previousSurfaceRef.current;
        previousSurfaceRef.current = presentation.surface;
        const wasOpen = previous === 'expanded' || previous === 'pinned';
        const leftPin = previous === 'pinned' && presentation.surface !== 'pinned';
        if (wasOpen !== open || leftPin) {
            emitInteraction('overlay-set-expanded', { expanded: open, ...(leftPin ? { target: null } : {}) });
        }
    }, [open, presentation.surface]);

    React.useEffect(() => {
        if (!open) {
            expandedFocusWithinRef.current = false;
            if (collapsedFocusReturnPendingRef.current) {
                collapsedFocusReturnPendingRef.current = false;
                collapsedTriggerRef.current?.focus();
            }
            return;
        }
        if (!keyboardExpandPendingRef.current) return;
        keyboardExpandPendingRef.current = false;
        // The resolved control is preferred; the shell keeps Escape reachable when the expanded model
        // has nothing to act on, or when its card was dismissed before the transfer ran.
        (expandedFocusTargetRef.current ?? expandedSurfaceRef.current)?.focus();
    }, [open]);

    const { surface, engaged } = presentation;
    const materialRestingRef = React.useRef(false);
    const presentFrame = React.useCallback((frame: NotchPresentFrame, current: Readonly<{ surface: NotchSurface; engaged: boolean }>) => {
        lastPresentFrameRef.current = frame;
        const bounds = flightBoundsRef.current;
        // While Extract flies, the flight layer is part of the extent: native keeps the envelope around it
        // and nothing settles until it lands (N2 flight seam).
        const settled = bounds ? false : frame.settled;
        if (!settled && materialRestingRef.current) {
            materialRestingRef.current = false;
            fireAndForget(setDesktopGlassPanelShape(null), { tag: 'DesktopActivityOverlayRoute.materialMoves' });
        }
        return presentDesktopActivityOverlay({
            surface: current.surface,
            engaged: current.engaged,
            extent: {
                width: frame.extent.width,
                height: frame.extent.height,
                cameraOffset: frame.cameraOffset,
                ...(bounds ? { screenBounds: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } } : {}),
            },
            settled,
        }).then(() => {
            if (!settled) return;
            // After native has framed the window: the material's place is relative to it.
            const { radius, ...place } = frame.material;
            materialRestingRef.current = true;
            return setDesktopGlassPanelShape(radius, place);
        }).catch(() => {});
    }, []);
    const presentationRef = React.useRef({ surface: presentation.surface, engaged: presentation.engaged });
    presentationRef.current = { surface: presentation.surface, engaged: presentation.engaged };
    const onPresent = React.useCallback((frame: NotchPresentFrame) => presentFrame(frame, { surface, engaged }), [engaged, presentFrame, surface]);

    /**
     * Extract's landing: the panel's rect flies to the window's rect while the island collapses behind it.
     * Endpoints stay in screen space, so an envelope that grows left or up moves only the layer's frame of
     * reference, never the flight. Reduced motion, or no origin or window rect yet: the island simply
     * steps back on its own (reduced) motion.
     */
    const landExtract = React.useCallback(async (windowRect: FlightRect | null) => {
        const origin = screenOriginRef.current;
        const from = !reducedMotion && windowRect && origin
            ? await measureRectInContainer(expandedSurfaceRef.current, rootRef.current) : null;
        if (!from || !windowRect || !origin) {
            dispatch({ type: 'rest' });
            return;
        }
        flightBoundsRef.current = unionFlightRects([{ x: from.x + origin.x, y: from.y + origin.y, w: from.w, h: from.h }, windowRect]);
        setFlight({ origin: { x: origin.x, y: origin.y }, size: { w: from.w, h: from.h } });
        const frame = lastPresentFrameRef.current;
        if (frame) void presentFrame(frame, presentationRef.current);
        dispatch({ type: 'rest' });
        await extractFlight.play(from, { x: windowRect.x - origin.x, y: windowRect.y - origin.y, w: windowRect.w, h: windowRect.h });
        flightBoundsRef.current = null;
        setFlight(null);
        const landed = lastPresentFrameRef.current;
        if (landed) void presentFrame({ ...landed, settled: true }, presentationRef.current);
    }, [dispatch, extractFlight, presentFrame, reducedMotion]);

    const applyPinnedDraftDirty = React.useCallback((dirty: boolean) => {
        pinnedDraftDirtyRef.current = dirty;
        setPinnedDraftDirty(dirty);
    }, []);

    const setExpandedFocusWithin = React.useCallback((focusWithin: boolean) => {
        expandedFocusWithinRef.current = focusWithin;
    }, []);

    const onCollapsedPress = React.useCallback((origin: DesktopActivityOverlayCollapsedPressOrigin) => {
        keyboardExpandPendingRef.current = origin === 'keyboard';
        dispatch({ type: 'click' });
    }, [dispatch]);

    /**
     * The island's single keyboard-dismissal decision, whichever control the key came from. A
     * nonempty pinned reply draft is the route-wide lock: Escape must never silently discard typed
     * text, so it stays put and the person clears or sends the draft first. Inline card editors own
     * the same decision locally because react-native-web does not bubble their key event; only an
     * empty inline answer forwards dismissal here.
     */
    const requestKeyboardDismiss = React.useCallback(() => {
        if (hasConversationRef.current && pinnedDraftDirtyRef.current) return;
        collapsedFocusReturnPendingRef.current = true;
        dispatch({ type: 'escape' });
    }, [dispatch]);

    // A face or Bot row opens where the person's "Open Bot conversations" says; the menu names the place.
    const pinnedPanelShown = presentation.surface === 'pinned' && hasConversation;
    const botHandlers = React.useMemo((): NotchBotHandlers => {
        const openIn = (face: BotFaceSnapshot, where: NotchBotOpenPresentation) => {
            // Each Bot keeps its own draft, so switching Bots never carries typed text across.
            if (where === 'overlay') dispatch({ type: 'set', state: 'pinned' });
            emitInteraction('session.open', { sessionId: face.sessionId, serverId: face.serverId, presentation: where });
        };
        return {
            onOpen: (face) => openIn(face, policy.botConversationPresentation),
            onOpenIn: openIn,
        };
    }, [dispatch, policy.botConversationPresentation]);

    // The list's pin keeps the island open (lab ntdock-T "Pinned"); the Bot conversation carries its own.
    const listPinned = presentation.surface === 'pinned';
    const listPin = React.useMemo(() => ({
        pinned: listPinned,
        onToggle: () => dispatch({ type: 'set', state: listPinned ? 'open' : 'pinned' }),
    }), [dispatch, listPinned]);
    const word = readStatusWord(collapsed);
    const botSection = React.useMemo(() => (faces && faces.faces.length > 0 ? { faces: faces.faces, handlers: botHandlers } : null),
        [botHandlers, faces]);
    const renderFaces = React.useCallback((orientation: 'row' | 'column') => (faces ? (
        <DesktopActivityOverlayFaces
            faces={faces}
            orientation={orientation}
            handlers={botHandlers}
            onMore={() => onCollapsedPress('pointer')}
        />
    ) : null), [botHandlers, faces, onCollapsedPress]);
    const slots: DesktopActivityOverlayStatusSlots = { faces: faces && faces.faces.length > 0 ? renderFaces : null, word };
    const extractPinned = React.useCallback(async (target: Readonly<{ sessionId: string; serverId: string | null }>) => {
        try {
            const result = await executeDesktopActivityOverlayInteractionWithResult({
                actionIdentifier: 'session.open',
                data: withOptionalServerId({ sessionId: target.sessionId, presentation: 'window' }, target.serverId),
            });
            if (!result.ok || !isWindowOpened(result.result)) return false;
            // The draft is that Session's own, so nothing moves with it but the panel's flight.
            void landExtract(readOpenedWindowRect(result.result));
            return true;
        } catch {
            return false;
        }
    }, [landExtract]);
    const performAction = React.useCallback<DesktopActivityOverlayActionHandler>(async (action) => {
        try {
            const result = await executeDesktopActivityOverlayInteractionWithResult({
                actionIdentifier: action.actionIdentifier,
                data: { ...action.data },
            });
            if (result.ok) return true;
            Modal.alert(t('common.error'), result.error ?? t('errors.operationFailed'));
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
        }
        return false;
    }, []);
    const accessibilityLabel = composeDesktopActivityOverlayAccessibilityLabel([
        t('settingsDesktop.overlay.title'),
        word?.text,
    ]);

    // Hidden orders the window out through the one `present` command; nothing else is drawn.
    const hidden = presentation.surface === 'hidden';
    const placement = frame ?? preFramePlacement(dock);
    React.useEffect(() => {
        if (presentation.surface !== 'hidden') return;
        fireAndForget(presentDesktopActivityOverlay({
            surface: 'hidden',
            engaged: false,
            extent: { width: 0, height: 0 },
            settled: true,
        }), { tag: 'DesktopActivityOverlayRoute.presentHidden' });
    }, [presentation.surface]);

    if (hidden) {
        return <View testID="desktop-activity-overlay-hidden" style={styles.hiddenContainer} />;
    }

    // The island is one dark material in every app theme, so everything on it reads the dark theme's ink,
    // controls and state colours rather than re-tinting light ones.
    return (
        <ScopedTheme name="dark">
            <View ref={rootRef} style={styles.container}>
                <NotchShape
                    testID="desktop-activity-overlay-notch"
                    dock={dock}
                    form={form}
                    growth={placement.growth}
                    anchorOffset={placement.anchorOffset}
                    camera={camera}
                    tipAccessibilityLabel={accessibilityLabel}
                    onPointerEnter={onShapePointerEnter}
                    onTipPress={() => onCollapsedPress('pointer')}
                    onPresent={onPresent}
                    renderStandard={(onLayout) => (
                        <DesktopActivityOverlayCollapsed
                            orientation={dock === 'left' || dock === 'right' ? 'column' : 'row'}
                            cameraGap={camera ? camera.width : null}
                            slots={slots}
                            accessibilityLabel={accessibilityLabel}
                            pressableRef={collapsedTriggerRef}
                            onPress={onCollapsedPress}
                            onLayout={onLayout}
                        />
                    )}
                    renderSideTab={word && slots.faces ? () => <DesktopActivityOverlaySideWordTab word={word} /> : null}
                    renderOpen={({ includeStatusRow, maxHeight, onNaturalHeight }) => (
                        <DesktopActivityOverlayListPanel
                            visualMode="notch_integrated"
                            header={includeStatusRow ? <DesktopActivityOverlayStatusHeader slots={slots} /> : undefined}
                            underStatusRow={!includeStatusRow}
                            maxHeight={maxHeight}
                            onNaturalHeight={onNaturalHeight}
                            bots={botSection}
                            pin={listPin}
                            content={pinnedPanelShown ? (
                                <DesktopActivityOverlayPinnedPanel
                                    phrases={policy.quickReplyPhrases}
                                    initialFocusRef={expandedFocusTargetRef}
                                    onDraftDirtyChange={applyPinnedDraftDirty}
                                    onBack={() => dispatch({ type: 'set', state: 'open' })}
                                    onUnpin={() => dispatch({ type: 'rest' })}
                                    onExtract={extractPinned}
                                    onAction={performAction}
                                    onDismissKey={requestKeyboardDismiss}
                                />
                            ) : undefined}
                            surfaceRef={expandedSurfaceRef}
                            initialFocusRef={expandedFocusTargetRef}
                            onFocusWithinChange={setExpandedFocusWithin}
                            onDismissKey={requestKeyboardDismiss}
                            onOpenSession={(sessionId, serverId) => {
                                emitInteraction(
                                    createActivitySurfaceSessionTarget(sessionId, serverId),
                                    withOptionalServerId({ sessionId }, serverId),
                                );
                                dispatch({ type: 'rest' });
                            }}
                            onAction={performAction}
                        />
                    )}
                />
                {extractFlight.active && flight ? (
                    // The flying panel, positioned against the window origin it took off from: when native grows
                    // the envelope left or up, only this frame of reference moves.
                    <View
                        testID="desktop-activity-overlay-extract-flight"
                        pointerEvents="none"
                        style={[styles.flightFrame, {
                            left: flight.origin.x - (screenOrigin?.x ?? flight.origin.x),
                            top: flight.origin.y - (screenOrigin?.y ?? flight.origin.y),
                        }]}
                    >
                        <RectFlightLayer style={extractFlight.style}>
                            <View style={[styles.flightPanel, { width: flight.size.w, height: flight.size.h }]} />
                        </RectFlightLayer>
                    </View>
                ) : null}
            </View>
        </ScopedTheme>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    flightFrame: {
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'visible',
    },
    // The island's own material in flight, rounded as the open panel is.
    flightPanel: {
        backgroundColor: theme.colors.overlay.stageImmersive,
        borderRadius: theme.borderRadius.modalCard,
    },
    hiddenContainer: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
    },
    loadingText: {
        color: theme.colors.text.secondary,
    },
}));
