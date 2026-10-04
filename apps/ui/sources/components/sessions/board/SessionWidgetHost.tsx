import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type {
    SessionBoardItemWidth,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { focusNativeAccessibilityTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import {
    HostedHtmlSurfaceAdapter,
    type CallerHostedHtmlRuntime,
} from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    resolveSessionBoardMountMode,
    sessionBoardSourceRequiresExclusiveMount,
    type SessionBoardExecutableCurrentness,
    type SessionBoardItemProjection,
    type SessionBoardMountHost,
} from '@/sync/domains/session/board';

import { SessionBoardDeclarativeContent } from './SessionBoardDeclarativeContent';
import { SessionWalkthroughWidgetContent } from './SessionWalkthroughWidgetContent';
import { InstalledWidgetSurface } from '@/components/widgets/InstalledWidgetSurface';
import { resolveBoardWidgetProvenance } from '@/components/widgets/boardWidgetProvenance';
import {
    beginSessionCompanionDrag,
    endSessionCompanionDrag,
    hasSessionCompanionDropTarget,
    moveSessionCompanionDrag,
    useSessionCompanionDropTargetAvailable,
} from '@/components/sessions/companion/drop/sessionCompanionDropStore';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { SessionBoardHostActionBinding } from './sessionBoardHostActions';
import {
    resolveSessionBoardItemPresentation,
    resolveSessionBoardItemTitle,
    type SessionBoardItemActionKind,
    type SessionBoardSourceAvailabilityResolver,
} from './sessionBoardItemPresentation';
import {
    resolveSessionBoardItemHeight,
    type SessionBoardHeightBounds,
} from './sessionBoardItemHeight';
import {
    advanceSessionBoardViewDropDwell,
    resolveSessionBoardAnchoredPointerDrop,
    resolveSessionBoardDragMove,
    resolveSessionBoardDragOffset,
    SessionBoardItemMoveHandle,
    type SessionBoardAnchoredMove,
    type SessionBoardItemRect,
    type SessionBoardViewDropDwell,
} from './SessionBoardItemMoveHandle';
import { buildSessionBoardItemActions, type SessionBoardItemMenuInput } from './sessionBoardItemMenu';

/**
 * The ONE durable Board item shell.
 *
 * It owns the item's title, provenance, frame, height and typed states, derives
 * whether this placement is the executable mount, and then hands rendering to the
 * incumbent renderer for the item's source. It never renders surface content
 * itself and never branches per host: Details, focused Details, the compact
 * sidebar, inline transcript references, the mobile Cockpit and the Companion all
 * mount this component through one of the three presentations below.
 *
 * Protocol and persistence say `item`; `widget` is the word people see.
 */

export type SessionWidgetDensity =
    /** The spacious Board grid. */
    | 'full'
    /** The one-column sidebar monitor/navigator. */
    | 'compact'
    /** An inert reference: inline transcript results and non-primary placements. */
    | 'preview';

export type SessionWidgetHostProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Exact Session projection captured by the route/shell owner. */
    session?: Session;
    item: SessionBoardItemProjection;
    host: SessionBoardMountHost;
    /** The locally derived executable placement for this item, or `null`. */
    primaryHost: SessionBoardMountHost | null;
    density: SessionWidgetDensity;
    /** Lane 04 `editSessionRecords`. Actions the person cannot perform are absent, not disabled. */
    canEdit: boolean;
    /**
     * Exact Board-record/access/reachability proof for executable sources.
     * Stale retained bytes remain visible, but never keep Host API authority.
     */
    executableCurrentness: SessionBoardExecutableCurrentness;
    /** Shared layout width intent, reported to assistive technology; the grid applies it. */
    width?: SessionBoardItemWidth;
    heightBounds: SessionBoardHeightBounds;
    /**
     * The mounted surface decides, from its own scroll geometry, that this card
     * is far enough outside the viewport that its body is not worth building
     * yet. Card chrome — title, menu, accessibility identity — always renders;
     * only the document, hosted surface or plugin frame waits.
     */
    deferBody?: boolean;
    /** Bounded renderer height report for an `auto` item, when the host measured one. */
    reportedHeight?: number | null;
    /**
     * The canonical expanded route for this item. Card geometry no longer bounds
     * the content, so a long or read-only note is fully readable and selectable
     * instead of being clipped or truncated.
     */
    expanded?: boolean;
    actionBinding?: SessionBoardHostActionBinding | null;
    resolveSourceAvailability?: SessionBoardSourceAvailabilityResolver;
    /** Exact Session-scoped plugin projection/currentness for executable items. */
    pluginRuntime?: SessionPluginRuntimeState;
    /** PEP-owned caller-HTML authority/bridge binding for this exact Session. */
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    /** Hand this item to the placement that can run it. */
    onOpenHere?: () => void;
    /** Delete the shared record and every placement, through the shared Board Action. */
    onRemove?: () => void;
    onManagePlugin?: () => void;
    onPrepareEncryption?: () => void;
    /** Inline rename; commits on Enter/blur, Escape restores. Full density only. */
    onRename?: (title: string) => void;
    /** Edit content in place when the mounted Board controller publishes a real editor handler. */
    onEdit?: () => void;
    /** Persist one semantic Board width. Full density only. */
    onResize?: (width: SessionBoardItemWidth) => void;
    /** Persist one anchored move within the current Board view. */
    onMove?: (direction: 'before' | 'after') => void;
    /** Commit a direct pointer drop through one semantic item anchor. */
    onMoveAnchored?: (anchor: SessionBoardAnchoredMove) => void;
    orderedMoveItemIds?: readonly string[];
    moveItemRects?: ReadonlyMap<string, SessionBoardItemRect>;
    /** There is a sibling to anchor against. At a view's end the direction is omitted. */
    canMoveBefore?: boolean;
    canMoveAfter?: boolean;
    /** One-based position in the active view, exposed by the move handle. */
    movePosition?: number;
    moveTotal?: number;
    /** Other shared Board views available to the same semantic move operation. */
    moveDestinations?: readonly Readonly<{ id: string; title: string }>[];
    onMoveToView?: (viewId: string) => void;
    /** Resolve a translated card center against the viewer-local Board-view strip. */
    resolveMoveToView?: (translationX: number, translationY: number) => string | null;
    /** Viewer-local drag telemetry consumed by the incumbent bounded autoscroll owner. */
    onDragActivityChange?: (active: boolean) => void;
    onDragTranslation?: (translationX: number, translationY: number) => void;
    /**
     * Persist one semantic height intent. Height belongs to the item, not the
     * placement, so the same content keeps a coherent vertical intent on every
     * Board view. Never a pixel value.
     */
    onSetHeight?: (height: SessionSurfaceItemV1['height']) => void;
    /** Add this existing shared item to the viewer's local Companion and reveal it. */
    onAddToCompanion?: () => void;
    /** Remove only the viewer-local Companion reference. */
    onRemoveFromCompanion?: () => void;
    /** Open the canonical expanded/full-content route for this item. */
    onReadFull?: () => void;
    /** Drop this view's placement. The shared item record survives. */
    onUnpin?: () => void;
    /** Exact one-shot focus handoff after this item replaces its editor. */
    focusHeadingRequestId?: number;
    onHeadingFocusHandled?: (requestId: number) => void;
    /** Host-specific truthful navigation label (for example, Open in Details). */
    openActionLabel?: string;
    /** This viewer keeps the item beside chat; the card carries a small Companion mark. */
    inCompanion?: boolean;
    /**
     * `section` places the item in the Companion column (lab F1): the Companion's metrics, with a
     * Board glyph in the meta slot saying the record lives on the Board.
     */
    frame?: 'card' | 'section';
    /**
     * Card or plain, already resolved by the placement (the item's override, else the surface's
     * Appearance default). Absent: the placement's default (Board card, Companion plain).
     */
    frameStyle?: WidgetFrameStyle;
    /** The item just arrived while the viewer was looking: the frame's one-shot ring. */
    fresh?: boolean;
    /**
     * The Board's shared per-placement frame override and the Board's Appearance default, for the
     * ⋯ menu's Show/Hide frame. Present only where the viewer may edit the Board layout.
     */
    frameOverride?: SessionBoardItemMenuInput['frame'];
    /** A placement's own controls (reorder, its item menu), drawn at the end of the header line. */
    headerAccessory?: React.ReactNode;
    /**
     * A read-only monitor card (the compact sidebar) is itself the way onto the Board: the whole
     * card opens the item where it is edited.
     */
    onPressCard?: () => void;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    titleWrap: {
        flexShrink: 1,
        minWidth: 0,
    },
    // The frame's title and source steps (the same as every widget frame), drawn here because the
    // Board's title is also a rename field and a drag handle.
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
    },
    titleInput: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
        paddingVertical: 2,
    },
    provenance: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    body: {
        minHeight: 0,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingTop: 10,
    },
}));

/**
 * A widget's source line. For an installed surface it names the real plugin and
 * contribution, so two plugin widgets on one Board stay distinguishable while
 * loading, updating and unavailable — see `widgetPresentation`.
 */
function itemProvenance(
    item: SessionBoardItemProjection,
    runtime: SessionPluginRuntimeState | undefined,
): ReturnType<typeof resolveBoardWidgetProvenance> | null {
    if (item.state.kind !== 'ready') return null;
    return resolveBoardWidgetProvenance(
        item.state.item.source,
        runtime?.pluginUiProjection ?? null,
    );
}

function actionLabel(kind: SessionBoardItemActionKind): string {
    switch (kind) {
        case 'remove':
            return t('sessionBoard.item.actions.remove');
        case 'openHere':
            return t('sessionBoard.item.actions.openHere');
        case 'managePlugin':
            return t('sessionBoard.item.actions.managePlugin');
        case 'prepareEncryption':
            return t('sessionBoard.item.actions.prepareEncryption');
    }
}

/**
 * Keep direct manipulation direct while making only the blocked same-view
 * ordering axis feel bounded. A cross-view target is a real destination, not a
 * same-view edge, so neither axis is resisted while the card is over one.
 */
export function resolveSessionBoardDragVisualOffset(input: Readonly<{
    translationX: number;
    translationY: number;
    canMoveBefore: boolean;
    canMoveAfter: boolean;
    crossViewTarget: boolean;
}>): Readonly<{ x: number; y: number }> {
    'worklet';

    if (input.crossViewTarget) {
        return { x: input.translationX, y: input.translationY };
    }
    const horizontalOrderingAxis = Math.abs(input.translationX) >= Math.abs(input.translationY);
    return horizontalOrderingAxis
        ? {
            x: resolveSessionBoardDragOffset({
                translation: input.translationX,
                canMoveBefore: input.canMoveBefore,
                canMoveAfter: input.canMoveAfter,
            }),
            y: input.translationY,
        }
        : {
            x: input.translationX,
            y: resolveSessionBoardDragOffset({
                translation: input.translationY,
                canMoveBefore: input.canMoveBefore,
                canMoveAfter: input.canMoveAfter,
            }),
        };
}

export function SessionWidgetHost(props: SessionWidgetHostProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const testID = props.testID ?? `session-board-item-${props.item.itemId}`;
    const [hostedFrameReportedHeight, setHostedFrameReportedHeight] = React.useState<number | null>(null);
    React.useLayoutEffect(() => {
        setHostedFrameReportedHeight(null);
    }, [props.item.itemId, props.item.revision]);
    const headingRef = React.useRef<Readonly<{ focus?: () => void }> | null>(null);
    const handledHeadingFocusRequestRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        const requestId = props.focusHeadingRequestId;
        if (requestId === undefined || handledHeadingFocusRequestRef.current === requestId) return;
        const target = headingRef.current;
        if (!target) return;
        handledHeadingFocusRequestRef.current = requestId;
        target.focus?.();
        focusNativeAccessibilityTarget(target as FocusReturnTarget);
        props.onHeadingFocusHandled?.(requestId);
    }, [props.focusHeadingRequestId, props.onHeadingFocusHandled]);
    const reduceMotion = useReducedMotionPreference();
    const liftDurationMs = reduceMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.fast;
    const dragX = useSharedValue(0);
    const dragY = useSharedValue(0);
    const dragging = useSharedValue(0);
    const dragCancelled = useSharedValue(0);
    const crossViewTargetActive = useSharedValue(false);
    const canMoveBefore = props.canMoveBefore === true;
    const canMoveAfter = props.canMoveAfter === true;
    const viewDropDwell = React.useRef<SessionBoardViewDropDwell | null>(null);
    const pointerDragActive = React.useRef(false);
    const pointerDragCancelled = React.useRef(false);
    const updateViewDropDwell = React.useCallback((translationX: number, translationY: number) => {
        const target = props.resolveMoveToView?.(translationX, translationY) ?? null;
        crossViewTargetActive.value = target !== null;
        if (target !== null) {
            // Target geometry is viewer-local React state, so it is resolved on
            // RN. Correct the same frame's provisional edge resistance as soon
            // as that owner confirms a real cross-view destination.
            dragX.value = translationX;
            dragY.value = translationY;
        }
        viewDropDwell.current = advanceSessionBoardViewDropDwell(viewDropDwell.current, target, Date.now());
    }, [crossViewTargetActive, dragX, dragY, props.resolveMoveToView]);
    const resetViewDropDwell = React.useCallback(() => {
        viewDropDwell.current = null;
        crossViewTargetActive.value = false;
    }, [crossViewTargetActive]);
    const beginPointerDrag = React.useCallback(() => {
        pointerDragActive.current = true;
        pointerDragCancelled.current = false;
        dragCancelled.value = 0;
        resetViewDropDwell();
    }, [dragCancelled, resetViewDropDwell]);
    const cancelPointerDrag = React.useCallback(() => {
        if (!pointerDragActive.current) return false;
        pointerDragActive.current = false;
        pointerDragCancelled.current = true;
        dragCancelled.value = 1;
        dragging.value = withTiming(0, { duration: liftDurationMs });
        dragX.value = withTiming(0, { duration: liftDurationMs });
        dragY.value = withTiming(0, { duration: liftDurationMs });
        resetViewDropDwell();
        props.onDragActivityChange?.(false);
        return true;
    }, [dragCancelled, dragX, dragY, dragging, liftDurationMs, props.onDragActivityChange, resetViewDropDwell]);
    const finalizePointerDrag = React.useCallback(() => {
        pointerDragActive.current = false;
    }, []);
    const commitDrag = React.useCallback((
        translationX: number,
        translationY: number,
        succeeded: boolean,
    ) => {
        const cancelled = pointerDragCancelled.current;
        pointerDragActive.current = false;
        pointerDragCancelled.current = false;
        if (!succeeded || cancelled) {
            viewDropDwell.current = null;
            return;
        }
        if (props.resolveMoveToView) {
            const target = props.resolveMoveToView(translationX, translationY);
            viewDropDwell.current = advanceSessionBoardViewDropDwell(viewDropDwell.current, target, Date.now());
        }
        const crossView = viewDropDwell.current;
        viewDropDwell.current = null;
        if (crossView?.armed) {
            props.onMoveToView?.(crossView.viewId);
            return;
        }
        if (props.onMoveAnchored && props.orderedMoveItemIds && props.moveItemRects) {
            const anchor = resolveSessionBoardAnchoredPointerDrop({
                draggedId: props.item.itemId,
                orderedIds: props.orderedMoveItemIds,
                itemRects: props.moveItemRects,
                translationX,
                translationY,
                droppedInside: true,
            });
            if (anchor) props.onMoveAnchored(anchor);
            return;
        }
        const direction = resolveSessionBoardDragMove({
            translationX,
            translationY,
            canMoveBefore,
            canMoveAfter,
            succeeded: true,
        });
        if (direction) props.onMove?.(direction);
    }, [
        canMoveAfter,
        canMoveBefore,
        props.item.itemId,
        props.moveItemRects,
        props.onMove,
        props.onMoveAnchored,
        props.onMoveToView,
        props.orderedMoveItemIds,
        props.resolveMoveToView,
    ]);
    const moveGesture = React.useMemo(() => Gesture.Pan()
        .minDistance(6)
        .onStart(() => {
            'worklet';
            dragging.value = withTiming(1, { duration: liftDurationMs });
            scheduleOnRN(beginPointerDrag);
            if (props.onDragActivityChange) scheduleOnRN(props.onDragActivityChange, true);
        })
        .onUpdate((event) => {
            'worklet';
            if (dragCancelled.value > 0) return;
            const visualOffset = resolveSessionBoardDragVisualOffset({
                translationX: event.translationX,
                translationY: event.translationY,
                canMoveBefore,
                canMoveAfter,
                crossViewTarget: crossViewTargetActive.value,
            });
            dragX.value = visualOffset.x;
            dragY.value = visualOffset.y;
            scheduleOnRN(updateViewDropDwell, event.translationX, event.translationY);
            if (props.onDragTranslation) scheduleOnRN(props.onDragTranslation, event.translationX, event.translationY);
        })
        // `success` is the ONLY thing separating a drop from a cancellation here;
        // both arrive through this callback.
        .onEnd((event, success) => {
            'worklet';
            // Escape is handled on RN while the pointer gesture finishes on the
            // UI thread. Capture the shared cancellation fact before finalize
            // resets it; otherwise a queued end callback can commit after the
            // person has explicitly restored the item.
            const shouldCommit = success && dragCancelled.value === 0;
            scheduleOnRN(commitDrag, event.translationX, event.translationY, shouldCommit);
        })
        .onFinalize(() => {
            'worklet';
            dragCancelled.value = 0;
            dragging.value = withTiming(0, { duration: liftDurationMs });
            scheduleOnRN(finalizePointerDrag);
            if (props.onDragActivityChange) scheduleOnRN(props.onDragActivityChange, false);
            if (liftDurationMs === 0) {
                dragX.value = 0;
                dragY.value = 0;
                return;
            }
            dragX.value = withSpring(0);
            dragY.value = withSpring(0);
        }), [
            canMoveAfter,
            canMoveBefore,
            beginPointerDrag,
            commitDrag,
            crossViewTargetActive,
            dragCancelled,
            dragX,
            dragY,
            dragging,
            finalizePointerDrag,
            liftDurationMs,
            updateViewDropDwell,
            props.onDragActivityChange,
            props.onDragTranslation,
        ]);
    // Keep beside your chat (lab CM, desktop web): a compact Board card the viewer can add to
    // the Companion may be dragged onto the Companion rail. The menu's "Add to Companion"
    // stays the canonical path; this is the same add, reached by hand. The detector is always
    // mounted (stable topology) and enabled only where the drag can land.
    const companionDropTargetAvailable = useSessionCompanionDropTargetAvailable(props.sessionId);
    const keepDragAvailable = isHoverCapablePrimaryPointer()
        && companionDropTargetAvailable
        && props.density === 'compact'
        && props.onAddToCompanion !== undefined
        && props.inCompanion !== true;
    const keepDragActive = React.useRef(false);
    const beginKeepDrag = React.useCallback(() => {
        if (!hasSessionCompanionDropTarget(props.sessionId)) return;
        keepDragActive.current = true;
        dragging.value = withTiming(1, { duration: liftDurationMs });
        beginSessionCompanionDrag(props.sessionId, props.item.itemId);
    }, [dragging, liftDurationMs, props.item.itemId, props.sessionId]);
    const moveKeepDrag = React.useCallback((x: number, y: number, translationX: number, translationY: number) => {
        if (!keepDragActive.current) return;
        dragX.value = translationX;
        dragY.value = translationY;
        moveSessionCompanionDrag(props.sessionId, x, y);
    }, [dragX, dragY, props.sessionId]);
    const endKeepDrag = React.useCallback((x: number, y: number, succeeded: boolean) => {
        if (!keepDragActive.current) return;
        keepDragActive.current = false;
        // The rail accepts the drop through the Companion's own add path.
        endSessionCompanionDrag(props.sessionId, succeeded ? { x, y } : null);
        dragging.value = withTiming(0, { duration: liftDurationMs });
        dragX.value = liftDurationMs === 0 ? 0 : withSpring(0);
        dragY.value = liftDurationMs === 0 ? 0 : withSpring(0);
    }, [dragX, dragY, dragging, liftDurationMs, props.sessionId]);
    const keepGesture = React.useMemo(() => Gesture.Pan()
        .enabled(keepDragAvailable)
        .minDistance(8)
        .onStart(() => {
            'worklet';
            scheduleOnRN(beginKeepDrag);
        })
        .onUpdate((event) => {
            'worklet';
            scheduleOnRN(moveKeepDrag, event.absoluteX, event.absoluteY, event.translationX, event.translationY);
        })
        .onEnd((event, success) => {
            'worklet';
            scheduleOnRN(endKeepDrag, event.absoluteX, event.absoluteY, success);
        })
        .onFinalize(() => {
            'worklet';
            scheduleOnRN(endKeepDrag, 0, 0, false);
        }), [beginKeepDrag, endKeepDrag, keepDragAvailable, moveKeepDrag]);
    const dragStyle = useAnimatedStyle(() => ({
        position: 'relative',
        zIndex: dragging.value > 0 ? 20 : 0,
        // Interpolated rather than switched, so the lift settles with the card
        // instead of snapping a frame before it.
        opacity: 1 - (dragging.value * 0.14),
        transform: [
            { translateX: dragX.value },
            { translateY: dragY.value },
            { scale: 1 + (dragging.value * 0.015) },
        ],
    }));
    const state = props.item.state;
    const mountMode = resolveSessionBoardMountMode({
        host: props.host,
        primaryHost: props.primaryHost,
        state,
    });
    const canOpenElsewhere = props.onOpenHere !== undefined;
    const embeddedPresentation = props.expanded === true ? 'fill' as const : 'content' as const;
    // Source availability has ONE owner (`createSessionBoardSourceAvailabilityResolver`),
    // supplied by the mounted controller. The item shell does not resolve plugin
    // projections a second time.
    const presentation = resolveSessionBoardItemPresentation({
        state,
        // `density` is visual chrome; whether this placement runs the item is answered
        // once by `resolveSessionBoardMountMode`. A second rule here made the compact
        // sidebar inert even when it was the elected primary host.
        mountMode,
        canEdit: props.canEdit,
        canOpenElsewhere,
        // The one embedded presentation this host will mount, from the live `expanded` fact
        // it owns — so renderer admission and the mount agree on the same presentation.
        embeddedPresentation,
        ...(props.resolveSourceAvailability
            ? { resolveSourceAvailability: props.resolveSourceAvailability }
            : {}),
    });

    const title = resolveSessionBoardItemTitle(state);
    const provenance = itemProvenance(props.item, props.pluginRuntime);
    // One header grammar at every density (F1): mark · title · source · meta · controls.
    const section = props.frame === 'section';
    // The monitor card opens on the Board from its heading (kind + title). Only the heading presses:
    // the card also holds its own menu and body controls, and a pressable card around them would
    // nest one button inside another.
    const onPressCard = props.onPressCard;
    const TitleFrame = (onPressCard ? Pressable : View) as React.ComponentType<React.ComponentProps<typeof Pressable>>;
    const titleFrameProps = onPressCard ? {
        testID: `${testID}-open`,
        onPress: onPressCard,
        accessibilityRole: 'button' as const,
        accessibilityLabel: provenance ? `${title}, ${provenance.label}` : title,
    } : {};
    // A fresh literal here made an equivalent context a new value on every parent render —
    // a same-item auto-height report was enough — which retired the mounted frame's Host API
    // bridge under an unchanged document. The mount's lifetime belongs to its identity, so
    // this value only changes when one of the facts it actually carries changes.
    const hostedHtmlSurfaceContext = React.useMemo(() => ({
        kind: 'widget' as const,
        sessionId: props.sessionId,
        itemId: props.item.itemId,
        recordRevision: props.item.revision,
        ...(state.kind === 'ready' && state.item.input !== undefined ? { input: state.item.input } : {}),
    }), [props.item.itemId, props.item.revision, props.sessionId, state]);

    const [draftTitle, setDraftTitle] = React.useState<string | null>(null);
    const renameEnabled = props.density === 'full' && props.canEdit && props.onRename !== undefined;
    const beginRename = React.useCallback(() => { setDraftTitle(title); }, [title]);
    const commitRename = React.useCallback(() => {
        const next = draftTitle?.trim() ?? '';
        setDraftTitle(null);
        if (next.length > 0 && next !== title) props.onRename?.(next);
    }, [draftTitle, props, title]);

    // The menu is the card's published operation set, built the same way the
    // Companion builds its own: one entry per handler that genuinely exists.
    const itemActions = React.useMemo(() => buildSessionBoardItemActions({
        density: props.density,
        canEdit: props.canEdit,
        item: state.kind === 'ready' ? state.item : null,
        width: props.width,
        onReadFull: props.onReadFull,
        onEdit: props.onEdit,
        // Pressing the title opens the same editor for a pointer; this is how a
        // keyboard and a screen reader reach rename at all.
        onRename: renameEnabled ? beginRename : undefined,
        onMove: props.onMove,
        canMoveBefore: props.canMoveBefore,
        canMoveAfter: props.canMoveAfter,
        moveDestinations: props.moveDestinations,
        onMoveToView: props.onMoveToView,
        onResize: props.onResize,
        reportedHeight: props.reportedHeight ?? hostedFrameReportedHeight,
        onSetHeight: props.onSetHeight,
        onAddToCompanion: props.onAddToCompanion,
        onRemoveFromCompanion: props.onRemoveFromCompanion,
        onUnpin: props.onUnpin,
        // Removal belongs with the other card operations, marked destructive and
        // last, rather than as the one control drawn louder than every
        // constructive one beneath every card.
        onRemove: props.onRemove,
        frame: props.frameOverride,
    }), [
        beginRename,
        props.canEdit,
        props.canMoveAfter,
        props.canMoveBefore,
        props.density,
        props.moveDestinations,
        props.onEdit,
        props.onMove,
        props.onMoveToView,
        props.onReadFull,
        props.onRemove,
        props.onResize,
        props.reportedHeight,
        hostedFrameReportedHeight,
        props.onSetHeight,
        props.onAddToCompanion,
        props.onRemoveFromCompanion,
        props.onUnpin,
        props.frameOverride,
        props.width,
        renameEnabled,
        state,
    ]);

    const runAction = React.useCallback((kind: SessionBoardItemActionKind | 'openHere' | null) => {
        switch (kind) {
            case 'remove':
                props.onRemove?.();
                return;
            case 'openHere':
                props.onOpenHere?.();
                return;
            case 'managePlugin':
                props.onManagePlugin?.();
                return;
            case 'prepareEncryption':
                props.onPrepareEncryption?.();
                return;
            case null:
                return;
        }
    }, [props]);

    const stateActions = presentation.kind === 'state'
        ? presentation.card.actionKinds.flatMap((kind) => {
            // Keep destructive removal in the existing menu when that menu is available.
            // Locked/missing records and inert previews retain their state-owned recovery.
            if (kind === 'remove' && itemActions.some((action) => action.id === 'remove')) return [];
            const available = kind === 'remove' ? props.onRemove !== undefined
                : kind === 'managePlugin' ? props.onManagePlugin !== undefined
                    : kind === 'prepareEncryption' ? props.onPrepareEncryption !== undefined
                        : kind === 'openHere' ? props.onOpenHere !== undefined
                            : false;
            return available ? [{
                label: actionLabel(kind),
                onPress: () => runAction(kind),
            }] : [];
        })
        : [];

    const resolvedHeight = state.kind === 'ready' && props.expanded !== true
        ? resolveSessionBoardItemHeight({
            height: state.item.height,
            reportedHeight: props.reportedHeight ?? hostedFrameReportedHeight,
            bounds: props.heightBounds,
        })
        : null;

    const executablePaused = presentation.kind === 'content'
        && state.kind === 'ready'
        && sessionBoardSourceRequiresExclusiveMount(state.item.source.kind)
        && props.executableCurrentness !== 'current';
    const executablePausedReason = props.executableCurrentness === 'offline'
        ? t('sessionBoard.board.offline')
        : props.executableCurrentness === 'stale'
            ? t('sessionBoard.board.stale')
            : t('sessionBoard.board.unavailable.reason');

    const body = executablePaused
        ? (
            <SurfaceStateCard
                testID={`${testID}-executable-${props.executableCurrentness}`}
                size={props.expanded ? undefined : 'line'}
                kind={props.executableCurrentness === 'unverified' ? 'unavailable' : 'warning'}
                title={t('sessionBoard.board.unavailable.title')}
                reason={props.expanded ? executablePausedReason : undefined}
                detail={props.expanded ? undefined : executablePausedReason}
                diagnosticCode={`session_board_executable_${props.executableCurrentness}`}
                accessibilitySemantics="status"
            />
        )
        : presentation.kind === 'state'
        ? (
            <SurfaceStateCard
                testID={`${testID}-state`}
                size={props.expanded ? undefined : 'line'}
                kind={presentation.card.kind}
                title={presentation.card.title}
                reason={props.expanded ? presentation.card.reason : undefined}
                detail={props.expanded ? undefined : presentation.card.reason}
                diagnosticCode={presentation.card.diagnosticCode}
                accessibilitySemantics="status"
                {...(stateActions[0] ? { action: stateActions[0] } : {})}
                {...(stateActions[1] ? { secondaryAction: stateActions[1] } : {})}
            />
        )
        : props.deferBody === true
        ? (
            <View
                testID={`${testID}-deferred`}
                style={{ minHeight: props.heightBounds.min }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            />
        )
        : state.kind === 'ready' && state.item.source.kind === 'walkthrough'
            ? <SessionWalkthroughWidgetContent sessionId={props.sessionId} serverId={props.serverId ?? null}
                comparisonKind={state.item.source.comparison} interactive={presentation.kind === 'content'} testID={`${testID}-walkthrough`} />
        : state.kind === 'ready' && state.item.source.kind === 'declarative'
            ? (
                <SessionBoardDeclarativeContent
                    testID={`${testID}-declarative`}
                    document={state.item.source.document}
                    // A preview is inert: it renders the same native content with no
                    // dispatch path, so a background placement cannot cause effects.
                    actionBinding={presentation.kind === 'content' ? props.actionBinding ?? null : null}
                />
            )
            : presentation.kind === 'content'
                && state.kind === 'ready'
                && state.item.source.kind === 'installedSurface'
                && props.item.revision !== null
                && props.pluginRuntime
                ? (
                    // Only a content presentation reaches here, so a preview or
                    // non-primary placement never instantiates an executable
                    // plugin frame, subscription or Host API binding.
                    //
                    // A Session projection that has not hydrated yet is that
                    // component's own loading state; naming it here would report
                    // an installed, projected widget as an unsupported renderer.
                    <InstalledWidgetSurface
                        testID={testID}
                        target={{
                            kind: 'session',
                            sessionId: props.sessionId,
                            ...(props.session ? { session: props.session } : {}),
                        }}
                        recordRevision={props.item.revision}
                        source={state.item.source}
                        {...(state.item.input === undefined ? {} : { input: state.item.input })}
                        // The embedded plugin presentation describes the actual
                        // host composition, not persisted outer card chrome.
                        presentation={embeddedPresentation}
                        runtime={props.pluginRuntime}
                        onIntrinsicHeightChange={setHostedFrameReportedHeight}
                        {...(props.onManagePlugin ? { onManagePlugin: props.onManagePlugin } : {})}
                    />
                )
                : presentation.kind === 'content'
                    && state.kind === 'ready' && state.item.source.kind === 'hostedHtml'
                    && props.item.revision !== null
                    && props.callerHostedHtmlRuntime
                    ? (
                        <HostedHtmlSurfaceAdapter
                            sessionId={props.sessionId}
                            title={state.item.title}
                            recordRevision={props.item.revision}
                            approvalSubject={stableJsonStringify([
                                'session-record',
                                props.callerHostedHtmlRuntime.serverIdentityId,
                                props.sessionId,
                                'surface/item.v1',
                                props.item.itemId,
                            ])}
                            source={state.item.source.source}
                            requestedCapabilities={state.item.source.requestedCapabilities}
                            {...(state.item.input === undefined ? {} : { input: state.item.input })}
                            surfaceContext={hostedHtmlSurfaceContext}
                            runtime={props.callerHostedHtmlRuntime}
                            onIntrinsicHeightChange={setHostedFrameReportedHeight}
                            testID={`${testID}-hosted-html`}
                        />
                    )
                : presentation.kind === 'preview'
                    ? (
                        // An inert reference to an executable item: the title,
                        // provenance and Open above are the whole preview. Drawing
                        // an "unavailable" card here would report a healthy widget
                        // that simply runs in another placement as broken, and
                        // rendering a miniature duplicate would start a second
                        // executable frame purely to look busy.
                        null
                    )
                    : (
                        // Executable sources reach this branch only when their renderer is
                        // available; the presentation resolver has already refused otherwise.
                        <SurfaceStateCard
                            testID={`${testID}-state`}
                            size={props.expanded ? undefined : 'line'}
                            kind="unavailable"
                            title={t('sessionBoard.item.rendererUnavailable.title')}
                            reason={props.expanded ? t('sessionBoard.item.rendererUnavailable.reason') : undefined}
                            detail={props.expanded ? undefined : t('sessionBoard.item.rendererUnavailable.reason')}
                            diagnosticCode="session_board_renderer_missing"
                            accessibilitySemantics="status"
                        />
                    );

    const previewAction = presentation.kind === 'preview' ? presentation.actionKind : null;

    // Frameless and full-bleed items reach the frame's real edge; the card clips them to its corner.
    const bodyReachesEdge = state.kind === 'ready'
        && (state.item.frame === 'frameless' || state.item.frame === 'full_bleed');
    const placement = section ? 'companion' as const : 'board' as const;
    const frameStyle = props.frameStyle ?? (section ? 'plain' : 'card');

    const moveHandle = props.density === 'full'
        && ((props.onMove && (props.canMoveBefore || props.canMoveAfter))
            || (props.onMoveToView && (props.moveDestinations?.length ?? 0) > 0)) ? (
            <SessionBoardItemMoveHandle
                testID={`${testID}-move-handle`}
                gesture={moveGesture}
                onMove={props.onMove ?? (() => undefined)}
                {...(props.onMoveAnchored ? { onMoveAnchored: props.onMoveAnchored } : {})}
                itemId={props.item.itemId}
                {...(props.orderedMoveItemIds ? { orderedItemIds: props.orderedMoveItemIds } : {})}
                canMoveBefore={props.canMoveBefore === true}
                canMoveAfter={props.canMoveAfter === true}
                // Its own name, not the Board-views strip beside it:
                // borrowing that label tells a screen-reader user
                // they are on an entirely different control.
                accessibilityLabel={t('sessionBoard.item.reorderA11y', { title })}
                itemTitle={title}
                onCancelPointerDrag={cancelPointerDrag}
                {...(props.moveDestinations ? { moveDestinations: props.moveDestinations } : {})}
                {...(props.onMoveToView ? { onMoveToView: props.onMoveToView } : {})}
                {...(props.movePosition !== undefined && props.moveTotal !== undefined
                    ? { position: props.movePosition, total: props.moveTotal }
                    : {})}
            />
        ) : null;

    const heading = (
        <GestureDetector gesture={keepGesture}>
            <TitleFrame style={styles.titleWrap} {...titleFrameProps}>
                {renameEnabled && draftTitle !== null ? (
                    <TextInput
                        testID={`${testID}-title-input`}
                        style={styles.titleInput}
                        value={draftTitle}
                        autoFocus
                        accessibilityLabel={t('sessionBoard.item.renameA11y')}
                        onChangeText={setDraftTitle}
                        onSubmitEditing={commitRename}
                        onBlur={commitRename}
                        onKeyPress={(event) => {
                            if (event.nativeEvent.key === 'Escape') setDraftTitle(null);
                        }}
                    />
                ) : (
                    <Text
                        ref={headingRef}
                        testID={`${testID}-title`}
                        style={styles.title}
                        tabIndex={-1}
                        numberOfLines={1}
                        accessibilityRole="header"
                        accessibilityLabel={props.width
                            ? t('sessionBoard.item.a11yLabelWithWidth', {
                                title,
                                width: t(`sessionBoard.width.${props.width}`),
                            })
                            : title}
                        {...(renameEnabled ? { onPress: beginRename } : {})}
                    >
                        {title}
                    </Text>
                )}
            </TitleFrame>
        </GestureDetector>
    );

    // Shown at every density, including an inert preview: the source IS most of what a preview
    // says, and it is the only thing that tells two plugin widgets apart. The visible name may
    // clip (or leave first when the frame narrows); the announced one keeps the exact identity.
    const source = provenance ? (
        <Text
            testID={`${testID}-provenance`}
            style={styles.provenance}
            numberOfLines={1}
            accessibilityLabel={provenance.accessibilityLabel}
        >
            {provenance.label}
        </Text>
    ) : undefined;

    // A Companion section identifies its shared Board record. Board cards keep their header
    // clear; Companion membership still controls drag admission and the menu's inverse action.
    const meta = section ? (
        <View
            testID={`${testID}-on-board-mark`}
            accessibilityRole="image"
            accessibilityLabel={provenance
                ? t('sessionCompanion.picker.onTheBoard', { source: provenance.label })
                : t('sessionBoard.companion.actions.openOnBoard')}
        >
            <Icon name="squares-four" size={13} color={theme.colors.text.tertiary} />
        </View>
    ) : null;

    const controls = moveHandle || itemActions.length > 0 || props.headerAccessory ? (
        <View style={styles.controls}>
            {moveHandle}
            {itemActions.length > 0 ? (
                <ItemRowActions
                    title={title}
                    actions={itemActions}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    overflowTriggerTestID={`${testID}-actions`}
                    overflowTriggerAccessibilityLabel={t('common.moreActions')}
                    iconSize={18}
                    gap={8}
                />
            ) : null}
            {props.headerAccessory}
        </View>
    ) : null;

    return (
        <Animated.View style={dragStyle}>
            {/*
              * No `accessible` wrapper here. Collapsing the card into one element
              * would hide Remove, the action menu, the renderer's own controls and
              * the content itself from assistive technology; the heading
              * supplies the grouping relationship instead.
              */}
            <WidgetFrame
                testID={testID}
                frameStyle={frameStyle}
                placement={placement}
                mark={sessionWidgetMark(state)}
                title={heading}
                {...(source ? { source } : {})}
                meta={meta}
                menu={controls}
                fresh={props.fresh === true}
                bodyStyle={bodyReachesEdge ? FULL_BLEED_BODY : undefined}
                body={{
                    kind: 'content',
                    children: (
                        <>
                            <View
                                testID={`${testID}-body`}
                                style={[styles.body, resolvedHeight ? { height: resolvedHeight.height } : null]}
                            >
                                {body}
                            </View>
                            {previewAction === 'openHere' ? (
                                <View style={styles.actions}>
                                    <RoundButton
                                        size="small"
                                        display="inverted"
                                        testID={`${testID}-open-here`}
                                        title={props.openActionLabel ?? actionLabel('openHere')}
                                        onPress={() => runAction('openHere')}
                                    />
                                </View>
                            ) : null}
                        </>
                    ),
                }}
            />
            {/*
              * Removal is NOT drawn here. It is the card's one destructive
              * operation and it lives last in the action menu with every
              * other card operation; as a standing button it was the only
              * always-visible control on a card whose constructive actions
              * all sat behind an overflow, which reads as an invitation to
              * delete.
              */}
        </Animated.View>
    );
}

/** The widget's mark in the frame header: what kind of thing it is, by its source. */
function sessionWidgetMark(state: SessionBoardItemProjection['state']): IconName {
    if (state.kind !== 'ready') return 'squares-four';
    switch (state.item.source.kind) {
        case 'walkthrough': return 'path';
        case 'declarative': return 'note';
        case 'hostedHtml': return 'squares-four';
        case 'installedSurface': return 'puzzle-piece';
    }
}

const FULL_BLEED_BODY = Object.freeze({ paddingLeft: 0, paddingRight: 0, paddingBottom: 0 });

// The `density` prop already expresses full / compact / inert-preview, so the
// three named wrappers were dead indirection over one shell and are gone. Hosts
// pass their density directly.
