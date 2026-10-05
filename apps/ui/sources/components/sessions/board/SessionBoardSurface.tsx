import * as React from 'react';
import { Animated, ScrollView, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    SessionBoardItemWidth,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { motionTokens, resolveInPlaceMorphTiming } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { Typography } from '@/constants/Typography';
import type { FocusReturnRef, FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { WidgetInstanceActionInputSchemasV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';
import { runBoardWidgetSetupCommand } from '@/components/widgets/surface/widgetSurfaceSetup';
import { measureWindowBounds, readWindowBounds, useTreeDropAutoscroll, useEntityDragDropRuntime, type WindowBounds } from '@/components/ui/treeDragDrop';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionSurfaceMeasurable, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh, SessionSurfaceEntityFeedback, type SessionSurfaceEntityBinding } from './SessionSurfaceEntityDrag';
import { resolveSessionBoardEntityDrop, sessionSurfaceDropRefused } from './sessionSurfaceEntityDrop';
import { executeSessionBoardEntityDrop, SessionBoardDestinationSchema, SessionBoardViewDestinationSchema } from './sessionBoardEntityBinding';
import { resolveSessionSurfaceKeyboardDestination } from './sessionSurfaceKeyboardDestination';
import { useWidgetMovementAdmission } from '@/components/widgets/surface/useWidgetMovementAdmission';
import {
    isSessionBoardEmpty,
    resolveSessionBoardExecutableCurrentness,
    resolveSessionBoardReferenceProjection,
    type SessionBoardItemProjection,
    type SessionBoardMountHost,
    type SessionBoardPrimaryMountResolver,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import {
    SESSION_BOARD_GRID_GAP_PX,
    resolveSessionBoardGridRowIndexes,
    resolveSessionBoardGridTier,
    resolveSessionBoardItemWidthPx,
} from './sessionBoardGridLayout';
import {
    resolveSessionBoardViewTitle,
    SessionBoardViewStrip,
    sessionBoardViewTabNativeId,
} from './SessionBoardViewStrip';
import { isSpanNearViewport, quantizeScrollOffset, resolveNearViewportWindow } from '@/components/widgets/nearViewport';
import { resolveSessionBoardAnchoredPointerDrop, type SessionBoardItemRect } from './sessionBoardMoveStrategy';
import { useWidgetFrameSurfaceDefault } from '@/components/widgets/frame/useWidgetFrameStyle';
import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { resolveWidgetFrameStyle } from '@/components/widgets/frame/widgetFrameStyle';
import { SessionWidgetHost, type SessionWidgetDensity } from './SessionWidgetHost';
import { useSessionBoardArrivals } from './useSessionBoardArrivals';
import { BoardWidgetAddPopover } from '@/components/widgets/add/BoardWidgetAddPopover';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { SessionBoardBodyEligibilityReporter } from './sessionBoardHostVisibility';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionBoardHostActionBinding } from './sessionBoardHostActions';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { SessionBoardController } from './useSessionBoardController';
import { useMountedSessionBoardContinuity } from './SessionBoardContinuity';
import {
    captureSessionBoardPresentationPosition,
    filterSessionBoardItemIds,
    resolveSessionBoardPresentationOffset,
} from './sessionBoardPresentationContinuity';
import { resolveSessionBoardFailurePresentation } from './sessionBoardFailurePresentation';

/**
 * One Board implementation for every host.
 *
 * Details, focused Details, the compact sidebar and the mobile Cockpit all render
 * this component; they differ only in the host they name, the density they ask for
 * and the width mapping their layout can afford. There is no per-placement Board,
 * no second grid and no desktop/mobile renderer split.
 *
 * It holds no Board state and owns no write path: every affordance it draws comes
 * from {@link SessionBoardController}, and it draws an affordance only when that
 * controller genuinely supports the command behind it.
 */

const GRID_GAP = SESSION_BOARD_GRID_GAP_PX;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
    scroll: {
        flex: 1,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: GRID_GAP,
        padding: GRID_GAP,
    },
    single: {
        flexDirection: 'column',
        gap: GRID_GAP,
        padding: GRID_GAP,
    },
    viewsRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 4,
    },
    viewsStrip: {
        flex: 1,
        minWidth: 0,
    },
    viewsActions: {
        paddingHorizontal: 4,
        paddingBottom: 4,
    },
    addRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: GRID_GAP,
        paddingTop: GRID_GAP,
    },
    freshness: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
        paddingHorizontal: GRID_GAP,
        paddingTop: 8,
    },
    mutationRecovery: {
        marginHorizontal: GRID_GAP,
        marginTop: GRID_GAP,
        gap: 10,
        alignItems: 'flex-start',
    },
    mutationRecoveryText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    section: {
        paddingHorizontal: GRID_GAP,
        paddingTop: 20,
        gap: 4,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    sectionBody: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));

export type { SessionBoardAddIntent } from './useSessionBoardController';

export type SessionBoardSurfaceProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    session?: Session;
    controller: SessionBoardController;
    host: SessionBoardMountHost;
    /** Resolves the executable placement for each exact item. */
    resolvePrimaryHost: SessionBoardPrimaryMountResolver;
    onBodyEligibilityChange?: SessionBoardBodyEligibilityReporter;
    density: SessionWidgetDensity;
    /** One column on mobile and in the compact sidebar; the semantic grid elsewhere. */
    layout: 'grid' | 'single';
    /** Sidebar composition: previews and navigation only; editing belongs in Details. */
    navigationOnly?: boolean;
    /**
     * A retained background tab: identical content, density and selected view,
     * but no mutation controls. Only the visible placement may act.
     */
    retained?: boolean;
    onOpenBoardDetails?: () => void;
    /** Host-local navigation; durable Board state remains owned by the shell controller. */
    onOpenItemHere?: (itemId: string) => void;
    resolveActionBinding?: (itemId: string) => SessionBoardHostActionBinding | null;
    pluginRuntime?: SessionPluginRuntimeState;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    /** The host's measured item height range. */
    heightBounds?: Readonly<{ min: number; max: number }>;
    /** Open this item's canonical expanded/full-content route in the current host. */
    onReadFullItem?: (itemId: string) => void;
    /** Viewer-local Companion membership supplied by its one preference owner. */
    companionItemIds?: ReadonlySet<string>;
    /** Adds the existing item reference and reveals Companion atomically. */
    onAddToCompanion?: (itemId: string) => void;
    /** Removes only the viewer-local reference; shared Board content survives. */
    onRemoveFromCompanion?: (itemId: string) => void;
    /**
     * Render one item's expanded route instead of the grid. This is the canonical
     * full-content destination for a long or read-only Note, and the nested view a
     * Board selection opens; it is not a second Board or a modal.
     */
    focusedItemId?: string | null;
    /** Leave the expanded route and return to the Board. */
    onLeaveFocusedItem?: () => void;
    testID?: string;
    /** Header slot rendered above the view strip. */
    header?: React.ReactNode;
    /** Retained in-place editor; it stays mounted through refresh/offline/conflict. */
    editor?: React.ReactNode;
    /** The Board's current-Session widget candidates, offered by the Add popover's From plugins. */
    addCandidates?: readonly WidgetCandidate[];
    /** Viewer-local tab hosts used only by the incumbent modal focus-return owner. */
    onViewFocusTargetChange?: (viewId: string, target: FocusReturnTarget) => void;
    /** Surviving Board-view action control when the source tab disappears. */
    onViewActionsFocusTargetChange?: (target: FocusReturnTarget) => void;
    viewActionsFocusTargetRef?: FocusReturnRef;
}>;

const DEFAULT_HEIGHT_BOUNDS = Object.freeze({ min: 96, max: 720 });
const NO_ADD_CANDIDATES: readonly WidgetCandidate[] = Object.freeze([]);

function BodyEligibility(props: Readonly<{
    host: SessionBoardMountHost;
    viewId: string;
    itemIdsKey: string;
    report: SessionBoardBodyEligibilityReporter;
}>): null {
    React.useLayoutEffect(() => props.report(
        props.host,
        props.viewId,
        new Set(props.itemIdsKey ? props.itemIdsKey.split('\u001f') : []),
    ), [props.host, props.viewId, props.itemIdsKey, props.report]);
    return null;
}

function boardStateCard(
    snapshot: SessionBoardSnapshot,
    testID: string,
    onPrepareEncryption?: () => void,
): React.ReactElement | null {
    switch (snapshot.layoutState.kind) {
        case 'loading':
            return (
                <SurfaceStateCard
                    testID={`${testID}-state`}
                    kind="loading"
                    title={t('sessionBoard.board.loading.title')}
                    reason={t('sessionBoard.board.loading.reason')}
                    accessibilitySemantics="status"
                />
            );
        case 'locked':
            return (
                <SurfaceStateCard
                    testID={`${testID}-state`}
                    kind="unavailable"
                    title={t('sessionBoard.board.locked.title')}
                    reason={t('sessionBoard.board.locked.reason')}
                    diagnosticCode="session_board_layout_locked"
                    {...(onPrepareEncryption
                        ? {
                            action: {
                                label: t('sessionBoard.item.actions.prepareEncryption'),
                                onPress: onPrepareEncryption,
                            },
                        }
                        : {})}
                    accessibilitySemantics="status"
                />
            );
        case 'unopenable':
            return (
                <SurfaceStateCard
                    testID={`${testID}-state`}
                    kind="error"
                    title={t('sessionBoard.board.unopenable.title')}
                    reason={t('sessionBoard.board.unopenable.reason')}
                    diagnosticCode={`session_board_layout_${snapshot.layoutState.reason}`}
                    accessibilitySemantics="alert"
                />
            );
        case 'unsupported':
            return (
                <SurfaceStateCard
                    testID={`${testID}-state`}
                    kind="unavailable"
                    title={t('sessionBoard.board.unsupported.title')}
                    reason={t('sessionBoard.board.unsupported.reason')}
                    diagnosticCode="session_board_layout_unsupported_version"
                    accessibilitySemantics="status"
                />
            );
        case 'ready':
            return null;
    }
}

/**
 * The one Add affordance, drawn wherever the person can add: it opens the shared widget Add
 * popover (lab `cwidgets` G1, Gallery | List), which offers only the intents whose producer exists
 * in this build. A source with no producer is absent rather than present and inert.
 */
function AddControls(props: Readonly<{
    controller: SessionBoardController;
    testID: string;
    /** `header`: the pane header's trailing + (the phone Board); `row`: the in-body Add button. */
    variant?: 'row' | 'header';
    sessionId: string;
    session?: Session;
    candidates: readonly WidgetCandidate[];
    pluginRuntime?: SessionPluginRuntimeState;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    if (props.controller.addIntents.length === 0) return null;
    const toggle = () => setOpen((value) => !value);
    const popover = (
        <BoardWidgetAddPopover
            open={open}
            anchorRef={anchorRef}
            onRequestClose={close}
            controller={props.controller}
            sessionId={props.sessionId}
            {...(props.session ? { session: props.session } : {})}
            candidates={props.candidates}
            {...(props.pluginRuntime ? { pluginRuntime: props.pluginRuntime } : {})}
            testID={`${props.testID}-add-popover`}
        />
    );
    if (props.variant === 'header') {
        return (
            <View testID={`${props.testID}-add`} ref={anchorRef} collapsable={false}>
                <IconButton
                    testID={`${props.testID}-add-trigger`}
                    iconName="plus"
                    variant="plain"
                    selected={open}
                    accessibilityLabel={t('common.add')}
                    tooltip={t('common.add')}
                    onPress={toggle}
                />
                {popover}
            </View>
        );
    }
    return (
        <View style={stylesheet.addRow} testID={`${props.testID}-add`}>
            <View ref={anchorRef} collapsable={false}>
                <RoundButton
                    size="small"
                    testID={`${props.testID}-add-trigger`}
                    title={t('common.add')}
                    leading={<Icon name="plus" size={16} color={theme.colors.button.primary.tint} />}
                    accessibilityLabel={t('common.add')}
                    expanded={open}
                    onPress={toggle}
                />
            </View>
            {popover}
        </View>
    );
}

function MutationRecoveryNotice(props: Readonly<{
    controller: SessionBoardController;
    testID: string;
}>): React.ReactElement | null {
    const recovery = props.controller.mutationRecovery;
    if (!recovery) return null;
    const presentation = resolveSessionBoardFailurePresentation(
        recovery.kind === 'conflict' ? 'session_board_revision_conflict' : 'outcome_unknown',
    );
    return (
        <SurfaceCard
            testID={`${props.testID}-mutation-recovery`}
            tone="muted"
            padding="md"
            style={stylesheet.mutationRecovery}
        >
            <Text
                style={stylesheet.mutationRecoveryText}
                accessibilityLiveRegion="polite"
                role="status"
            >
                {presentation.message}
            </Text>
            {recovery.ready ? (
                <RoundButton
                    testID={`${props.testID}-mutation-recovery-retry`}
                    size="small"
                    title={t('common.retry')}
                    accessibilityLabel={t('common.retry')}
                    action={props.controller.retryLastMutation}
                />
            ) : null}
        </SurfaceCard>
    );
}

/** Board-view administration, beside the strip and never inside it. */
function ViewActions(props: Readonly<{
    controller: SessionBoardController;
    testID: string;
    onBeginRename: (viewId: string) => void;
    onFocusTargetChange?: (target: FocusReturnTarget) => void;
}>): React.ReactElement | null {
    const controller = props.controller;
    const activeView = controller.activeView;
    const views = controller.snapshot?.views;
    const actions = React.useMemo((): ItemAction[] => {
        const built: ItemAction[] = [];
        if (controller.supports('view.create')) {
            built.push({
                id: 'view-create',
                title: t('sessionBoard.views.actions.create'),
                icon: 'plus',
                onPress: () => { void controller.run({ kind: 'view.create' }); },
            });
        }
        if (activeView && !activeView.synthetic && controller.supports('view.rename')) {
            // A view move needs a real neighbour to anchor against, exactly as an
            // item move does. At either end of the strip the layout Action has
            // nothing to write, so the direction is omitted rather than offered
            // and silently ignored.
            const ordered = views ?? [];
            const index = ordered.findIndex((candidate) => candidate.id === activeView.id);
            const anchorAt = (offset: number) => {
                const candidate = index < 0 ? undefined : ordered[index + offset];
                return candidate !== undefined && !candidate.synthetic;
            };
            built.push({
                id: 'view-rename',
                title: t('sessionBoard.views.actions.rename'),
                icon: 'pencil',
                onPress: () => props.onBeginRename(activeView.id),
            });
            if (anchorAt(-1)) {
                built.push({
                    id: 'view-move-before',
                    title: t('sessionBoard.views.actions.moveBefore'),
                    icon: 'arrow-up',
                    onPress: () => { void controller.run({ kind: 'view.move', viewId: activeView.id, direction: 'before' }); },
                });
            }
            if (anchorAt(1)) {
                built.push({
                    id: 'view-move-after',
                    title: t('sessionBoard.views.actions.moveAfter'),
                    icon: 'arrow-down',
                    onPress: () => { void controller.run({ kind: 'view.move', viewId: activeView.id, direction: 'after' }); },
                });
            }
            built.push({
                id: 'view-remove',
                title: t('sessionBoard.views.actions.remove'),
                icon: 'trash',
                destructive: true,
                onPress: () => { void controller.run({ kind: 'view.remove', viewId: activeView.id }); },
            });
        }
        return built;
    }, [activeView, controller, props, views]);

    if (actions.length === 0) return null;
    return (
        <View style={stylesheet.viewsActions}>
            <ItemRowActions
                title={t('sessionBoard.views.label')}
                actions={actions}
                compactThreshold={Number.POSITIVE_INFINITY}
                overflowTriggerTestID={`${props.testID}-view-actions`}
                overflowTriggerAccessibilityLabel={t('common.moreActions')}
                iconSize={18}
                gap={8}
                onOverflowTriggerFocusTargetChange={props.onFocusTargetChange}
            />
        </View>
    );
}

/**
 * The empty Board's first steps (lab ST): Ask the agent leads — it only drafts a sentence into this
 * Session's composer and sends nothing, so even the read-only sidebar may offer it — and Add a note
 * is the quiet second way wherever the placement may write.
 */
function emptyBoardActions(
    controller: SessionBoardController,
    mutationControls: boolean,
): Readonly<{ action?: SurfaceStateAction; secondaryAction?: SurfaceStateAction }> {
    const askAgent: SurfaceStateAction | null = controller.addIntents.includes('askAgent')
        ? { label: t('sessionBoard.empty.editor.askAgent'), onPress: () => { void controller.run({ kind: 'add', intent: 'askAgent' }); } }
        : null;
    const addNote: SurfaceStateAction | null = mutationControls && controller.addIntents.includes('note')
        ? { label: t('sessionBoard.empty.editor.addNote'), onPress: () => { void controller.run({ kind: 'add', intent: 'note' }); } }
        : null;
    if (askAgent) return addNote ? { action: askAgent, secondaryAction: addNote } : { action: askAgent };
    return addNote ? { action: addNote } : {};
}

/**
 * The Board's signature (lab B): a card opened from the sidebar grows into its place on the Details
 * Board — the in-place morph timeline Home's setup tiles and the Share panel use — and under reduced
 * motion it simply cross-fades in.
 */
function BoardItemArrival(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const progress = React.useRef(new Animated.Value(0)).current;
    React.useEffect(() => {
        const timing = resolveInPlaceMorphTiming(reducedMotion);
        const animation = Animated.timing(progress, {
            toValue: 1,
            duration: timing.clockMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        });
        animation.start();
        return () => animation.stop();
    }, [progress, reducedMotion]);
    return (
        <Animated.View
            style={{
                opacity: progress,
                ...(reducedMotion ? {} : {
                    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
                }),
            }}
        >
            {props.children}
        </Animated.View>
    );
}

export function SessionBoardSurface(props: SessionBoardSurfaceProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'session-board';
    const accessibilityInstanceId = React.useId().replace(/:/g, '');
    const viewTabIdPrefix = `session-board-${accessibilityInstanceId}-view-tab`;
    const viewPanelId = `session-board-${accessibilityInstanceId}-tabpanel`;
    const controller = props.controller;
    const snapshot = controller.snapshot;
    const { binding: dragScope } = useServerCredentialAccountScopeBinding(props.serverId);
    const dragRuntime = useEntityDragDropRuntime();
    const dragAddress = normalizeSessionAddress(dragScope?.serverId, props.sessionId);
    // A sidebar preview and a retained background tab are read-only for
    // different reasons, but neither may draw a control that writes to the
    // shared Board. Only `navigationOnly` also changes the projection itself;
    // a retained tab keeps its density, layout and selected view untouched.
    const mutationControls = props.navigationOnly !== true && props.retained !== true;
    // One subscription to the Board's Appearance default on this device; each card resolves against it.
    const boardFrameDefault = useWidgetFrameSurfaceDefault('board');
    // A card that arrives while this Board is on screen gets the frame's one-shot ring (lab WA).
    const arrivals = useSessionBoardArrivals(
        snapshot && snapshot.layoutState.kind === 'ready' && !snapshot.incomplete ? [...snapshot.itemsById.keys()] : null,
    );
    const continuity = useMountedSessionBoardContinuity();
    const heightBounds = props.heightBounds ?? DEFAULT_HEIGHT_BOUNDS;
    const [gridWidth, setGridWidth] = React.useState(0);
    const windowHeight = useWindowDimensions().height;
    const [measuredViewportHeight, setMeasuredViewportHeight] = React.useState(0);
    const [bodyWindowTopOffset, setBodyWindowTopOffset] = React.useState(0);
    const [renamingViewId, setRenamingViewId] = React.useState<string | null>(null);
    const [mobileQuery, setMobileQuery] = React.useState('');
    const placementRects = React.useRef(new Map<string, SessionBoardItemRect>());
    // Recovered rows live in their own section below the grid, so their rects are measured
    // against that section's origin rather than the grid's.
    const recoveredRects = React.useRef(new Map<string, SessionBoardItemRect>());
    const recoveredSectionY = React.useRef(0);
    const recoveredRowsY = React.useRef(0);
    const [, setGeometryRevision] = React.useState(0);
    /**
     * A measurement is new information about where a card actually is.
     *
     * Rects stay in refs because drag geometry reads them synchronously mid-gesture, but the
     * body window has to be recomputed whenever one MOVES: before layout the window can only
     * estimate, and a wrapped grid's estimate is the one that leaves a visible card blank.
     * A responsive reflow is the same problem one step later — the pane widens, the grid
     * re-wraps, and a card measured far below the fold is suddenly on screen. Reacting only
     * to the first rect left it showing chrome over a blank body until an unrelated scroll.
     * Identical rects are ignored, so a layout pass that settles stops here; React batches
     * the burst of `onLayout` calls, so no coalescing of its own is needed.
     */
    const recordItemRect = React.useCallback((
        rects: Map<string, SessionBoardItemRect>,
        itemId: string,
        rect: SessionBoardItemRect,
    ) => {
        const previous = rects.get(itemId);
        rects.set(itemId, rect);
        const moved = previous === undefined
            || previous.x !== rect.x
            || previous.y !== rect.y
            || previous.width !== rect.width
            || previous.height !== rect.height;
        if (moved) setGeometryRevision((revision) => revision + 1);
    }, []);
    /** A section origin moves every rect measured against it, so it bumps the same way. */
    const recordSectionOrigin = React.useCallback((
        origin: { current: number },
        y: number,
    ) => {
        if (origin.current === y) return;
        origin.current = y;
        setGeometryRevision((revision) => revision + 1);
    }, []);
    const viewRects = React.useRef(new Map<string, SessionBoardItemRect>());
    const viewsRowY = React.useRef(0);
    const viewsHorizontalOffset = React.useRef(0);
    const scrollViewportY = React.useRef(0);
    const scrollOffsetY = React.useRef(0);
    const gridContentY = React.useRef(0);
    const scrollRef = React.useRef<ScrollView>(null);
    const scrollWindow = React.useRef<WindowBounds | null>(null);
    const orderedPresentationItemIds = React.useRef<readonly string[]>([]);
    const presentationKey = `view:${controller.activeViewId}`;
    const dragAutoscrollActive = useSharedValue(false);
    const dragPointerContentY = useSharedValue<number | null>(null);
    const scrollViewportTop = useSharedValue(0);
    const scrollViewportHeight = useSharedValue(0);
    const scrollOffset = useSharedValue(0);
    const scrollContentHeight = useSharedValue(0);
    const scrollToOffset = React.useCallback((offsetY: number) => {
        scrollRef.current?.scrollTo({ y: offsetY, animated: false });
        dragRuntime.refresh();
    }, [dragRuntime]);
    useTreeDropAutoscroll({
        isActive: dragAutoscrollActive,
        pointerY: dragPointerContentY,
        viewportTopY: scrollViewportTop,
        viewportHeight: scrollViewportHeight,
        scrollOffsetY: scrollOffset,
        contentHeight: scrollContentHeight,
        scrollToOffset,
    });
    const measureDragViewport = React.useCallback(() => {
        void measureWindowBounds(sessionSurfaceMeasurable(scrollRef.current)).then(bounds => {
            scrollWindow.current = bounds;
            scrollViewportTop.value = bounds?.y ?? 0;
            dragRuntime.refresh();
        });
    }, [dragRuntime, scrollViewportTop]);
    useSessionSurfaceGeometryRefresh(measureDragViewport);
    React.useEffect(() => {
        const update = () => {
            const current = dragRuntime.getSnapshot();
            const effect = current.admission?.status === 'allowed' ? current.admission.effect : null;
            const widgetMove = effect?.actionId === 'widgets.instance.move'
                ? WidgetInstanceActionInputSchemasV1['widgets.instance.move'].safeParse(effect.input) : null;
            const targetsBoard = effect?.actionId === 'session.board.layout.update'
                || widgetMove?.success && 'to' in widgetMove.data && widgetMove.data.to.surface.owner.kind === 'sessionBoard'
                    && widgetMove.data.to.surface.owner.sessionId === props.sessionId;
            dragAutoscrollActive.value = current.phase === 'carrying' && !!targetsBoard
                && current.item?.scope.serverId === dragScope?.serverId && current.item?.scope.accountId === dragScope?.accountId;
            if (!dragAutoscrollActive.value) dragPointerContentY.value = null;
        };
        update();
        return dragRuntime.subscribe(update);
    }, [dragRuntime, dragScope, props.sessionId, dragAutoscrollActive, dragPointerContentY]);
    const widgetMovementSurface = React.useMemo(() => dragScope && dragAddress ? { ...dragScope.scope, owner: { kind: 'sessionBoard' as const, sessionId: dragAddress.sessionId } } : null, [dragScope, dragAddress]);
    const widgetMovement = useWidgetMovementAdmission(props.retained ? null : widgetMovementSurface, controller.snapshot);
    const admitWidgetMovement = widgetMovement.admit;
    const viewStripDrag = useSessionSurfaceEntityDrag(dragScope && dragAddress && mutationControls ? {
        scope: dragScope.scope, isCurrent: () => dragScope.isCurrent() && controller.supports('item.moveAnchored'),
        admitWidgetMovement,
        getItem: () => null, title: t('sessionBoard.views.label'),
        pointerDestination: (bounds, pointer) => {
            for (const [viewId, rect] of viewRects.current) {
                const x = bounds.x + rect.x - viewsHorizontalOffset.current;
                const y = bounds.y + rect.y;
                if (pointer.x >= x && pointer.x <= x + rect.width && pointer.y >= y && pointer.y <= y + rect.height) return { viewId };
            }
            return null;
        },
        target: { acceptedKinds: ['session-board-item', 'companion-item', 'home-section', 'work-board-widget', 'widget-area-instance'],
            listDestinations: () => (controller.snapshot?.views ?? []).filter(view => !view.synthetic).map(view => ({ destination: { viewId: view.id }, label: resolveSessionBoardViewTitle(view), group: t('sessionBoard.views.label') })),
            resolve: ({ item, destination }) => {
                const parsed = SessionBoardViewDestinationSchema.safeParse(destination);
                const viewId = parsed.success ? parsed.data.viewId : null;
                return viewId ? resolveSessionBoardEntityDrop({ item, scope: dragScope.scope, address: dragAddress, board: controller.snapshot, viewId, widgetSourceRef: widgetMovement.sourceRef,
                    preview: { verb: t('sessionBoard.item.moveTargetView', { title: controller.snapshot?.views.find(view => view.id === viewId)?.title ?? t('sessionBoard.views.label') }), target: controller.snapshot?.views.find(view => view.id === viewId)?.title ?? t('sessionBoard.views.label') } }) : sessionSurfaceDropRefused('target-gone');
            },
            execute: effect => executeSessionBoardEntityDrop(controller, effect),
        },
    } : null);
    const onGridLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = Math.trunc(event.nativeEvent.layout.width);
        recordSectionOrigin(gridContentY, event.nativeEvent.layout.y);
        setGridWidth((current) => (current === width ? current : width));
    }, [recordSectionOrigin]);
    const capturePresentationPosition = React.useCallback((offset: number) => {
        continuity?.presentationPositions.write(presentationKey, captureSessionBoardPresentationPosition({
            orderedItemIds: orderedPresentationItemIds.current,
            itemRects: placementRects.current,
            contentStartY: gridContentY.current,
            scrollOffset: offset,
        }));
    }, [continuity, presentationKey]);
    const restorePresentationPosition = React.useCallback(() => {
        const position = continuity?.presentationPositions.read(presentationKey);
        if (!position) return;
        scrollRef.current?.scrollTo({
            y: resolveSessionBoardPresentationOffset({
                position,
                itemRects: placementRects.current,
                contentStartY: gridContentY.current,
            }),
            animated: false,
        });
    }, [continuity, presentationKey]);

    // The sidebar monitor and the phone Board speak through the one pane header (lab B/Bp): who sees
    // the Board and how much is on it, then the likeliest next step — Open board from the read-only
    // sidebar, + (the Add chooser) on the phone. Details has no pane header and keeps its own row.
    const headerHost = props.host === 'sidebar' || props.host === 'mobileCockpit';
    const snapshotPresent = snapshot !== null;
    // An empty Board says only who sees it (lab ST); the count appears once there is something to count.
    const widgetCount = snapshot && snapshot.layoutState.kind === 'ready' && !snapshot.incomplete && snapshot.itemsById.size > 0
        ? snapshot.itemsById.size
        : null;
    const headerIconColor = theme.colors.text.secondary;
    const headerLine = React.useMemo(() => (!headerHost || !snapshotPresent ? null : {
        leading: <Icon name="users" size={13} color={headerIconColor} />,
        segments: [
            t('sessionBoard.sidebar.sharedWithEveryone'),
            ...(widgetCount === null ? [] : [t('sessionBoard.sidebar.widgetCount', { count: widgetCount })]),
        ],
    }), [headerHost, headerIconColor, snapshotPresent, widgetCount]);
    const onOpenBoardDetails = props.onOpenBoardDetails;
    // What the Add popover offers beyond the controller's intents: this Session's exact projection
    // (for the live previews) and the Board's one current-Session candidate list.
    const addSource = React.useMemo(() => ({
        sessionId: props.sessionId,
        ...(props.session ? { session: props.session } : {}),
        candidates: props.addCandidates ?? NO_ADD_CANDIDATES,
        ...(props.pluginRuntime ? { pluginRuntime: props.pluginRuntime } : {}),
    }), [props.addCandidates, props.pluginRuntime, props.session, props.sessionId]);
    const headerAction = React.useMemo(() => {
        if (props.host === 'sidebar') {
            return onOpenBoardDetails ? (
                <IconButton
                    testID={`${testID}-header-open-board`}
                    iconName="arrows-out"
                    variant="plain"
                    accessibilityLabel={t('sessionBoard.sidebar.openBoard')}
                    tooltip={t('sessionBoard.sidebar.openBoard')}
                    onPress={onOpenBoardDetails}
                />
            ) : null;
        }
        if (props.host === 'mobileCockpit' && mutationControls && snapshotPresent) {
            return <AddControls controller={controller} testID={testID} variant="header" {...addSource} />;
        }
        return null;
    }, [addSource, controller, mutationControls, onOpenBoardDetails, props.host, snapshotPresent, testID]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine, action: headerAction }), [headerAction, headerLine]));

    if (!snapshot) {
        return <View style={styles.root} testID={testID} />;
    }

    const activeView = controller.activeView;
    const layoutCard = boardStateCard(
        snapshot,
        testID,
        mutationControls && controller.supports('item.prepareEncryption')
            ? () => { void controller.run({ kind: 'item.prepareEncryption' }); }
            : undefined,
    );

    // Offline and stale are explained, never faked: the last content the person
    // loaded stays on screen and the freshness line says why it may be behind.
    // Nothing retained is never a stale line over an empty body (pane-states): it is a state card.
    const hasRetainedContent = snapshot.itemsById.size > 0;
    const offline = snapshot.reachability === 'offline';
    const freshnessLabel = !hasRetainedContent
        ? null
        : offline
            ? t('sessionBoard.board.offline')
            : snapshot.freshness === 'stale'
                ? t('sessionBoard.board.stale')
                : null;
    const offlineEmptyCard = offline && !hasRetainedContent ? (
        <SurfaceStateCard
            testID={`${testID}-offline`}
            kind="unavailable"
            iconName="cloud-slash"
            title={t('sessionBoard.board.offlineEmpty')}
            accessibilitySemantics="status"
        />
    ) : null;

    const boardEmpty = isSessionBoardEmpty(snapshot);
    const placements = activeView?.placements ?? [];
    const recovered = controller.recoveredItemIds;
    const visiblePlacementIds = props.host === 'mobileCockpit'
        ? filterSessionBoardItemIds({
            orderedItemIds: placements.map((placement) => placement.itemId),
            itemsById: snapshot.itemsById,
            query: mobileQuery,
        })
        : placements.map((placement) => placement.itemId);
    const visiblePlacementIdSet = new Set(visiblePlacementIds);
    const visiblePlacements = placements.filter((placement) => visiblePlacementIdSet.has(placement.itemId));
    const visibleRecovered = props.host === 'mobileCockpit'
        ? filterSessionBoardItemIds({ orderedItemIds: recovered, itemsById: snapshot.itemsById, query: mobileQuery })
        : recovered;
    orderedPresentationItemIds.current = visiblePlacementIds;

    /**
     * Semantic spans as real widths.
     *
     * The grid recomposes in whole tiers at its measured width rather than
     * letting each card fall back on its own, so the person's intent survives
     * every window size: a `compact` card can never end up drawn wider than the
     * `medium` beside it.
     */
    const gridAvailableWidth = gridWidth - (GRID_GAP * 2);
    const gridTier = resolveSessionBoardGridTier(gridAvailableWidth);
    const itemWidthFor = (width: SessionBoardItemWidth): number | null => {
        if (props.layout !== 'grid' || gridWidth <= 0) return null;
        return resolveSessionBoardItemWidthPx({
            width,
            availableWidthPx: gridAvailableWidth,
            tier: gridTier,
        });
    };

    /**
     * Which cards build their body: the shared near-viewport rule
     * (`components/widgets/nearViewport`), which Home uses too.
     *
     * Opening a Board must not instantiate every document, hosted surface and
     * plugin frame it holds, so a card outside the window draws its chrome and
     * waits. The quantum is the surface's own minimum card height
     * (`heightBounds.min`), which is also a sound lower bound on where an
     * unmeasured card at row `n` can start. Before the ScrollView reports its
     * height the platform window height stands in for it, so the very first
     * frame is bounded too.
     *
     * Card chrome always renders, so an offscreen card keeps its title, menu and
     * accessibility identity; only the expensive content waits.
     */
    const bodyWindowQuantum = Math.max(1, heightBounds.min);
    const bodyWindow = resolveNearViewportWindow({
        windowTopOffset: bodyWindowTopOffset,
        viewportHeight: measuredViewportHeight > 0 ? measuredViewportHeight : windowHeight,
        quantum: bodyWindowQuantum,
    });
    // The grid wraps, so the unmeasured estimate is placed by ROW, not by ordinal: three
    // `compact` cards share a row at the twelve-column tier, and reading the third one as
    // three rows down pushes cards the person can see out of the window.
    const placementRowIndexes = resolveSessionBoardGridRowIndexes({
        widths: visiblePlacements.map((placement) => placement.width),
        tier: props.layout === 'grid' && gridWidth > 0 ? gridTier : 'single',
    });
    const recoveredRowBase = (placementRowIndexes[placementRowIndexes.length - 1] ?? -1) + 1;
    const isItemBodyNearViewport = (input: Readonly<{
        itemId: string;
        row: number;
        rects: Map<string, SessionBoardItemRect>;
        contentStartY: number;
    }>): boolean => {
        const rect = input.rects.get(input.itemId);
        return isSpanNearViewport(bodyWindow, rect
            ? { top: input.contentStartY + rect.y, height: rect.height }
            : { top: input.row * bodyWindowQuantum });
    };
    // One eligibility result drives both lazy body rendering and the shared shell
    // resolver. A card whose body is deferred cannot suppress a visible Companion.
    const bodyEligibleItemIds = new Set([
        ...visiblePlacements.filter((placement, ordinal) => isItemBodyNearViewport({
            itemId: placement.itemId,
            row: placementRowIndexes[ordinal] ?? ordinal,
            rects: placementRects.current,
            contentStartY: gridContentY.current,
        })).map((placement) => placement.itemId),
        ...visibleRecovered.filter((itemId, index) => isItemBodyNearViewport({
            itemId,
            row: recoveredRowBase + index,
            rects: recoveredRects.current,
            contentStartY: recoveredSectionY.current + recoveredRowsY.current,
        })),
    ]);

    // Item recovery navigation comes from the same controller that answers for the
    // Board-level card above, so an item and its Board can never disagree about
    // whether a way out of a locked or retired source exists.
    const renderItem = (
        itemId: string,
        width: SessionBoardItemWidth,
        expanded = false,
        projectedOverride?: SessionBoardItemProjection,
        deferBody = false,
    ) => {
        const projected = projectedOverride ?? snapshot.itemsById.get(itemId);
        if (!projected) return null;
        // Edit is item-specific: caller-authored HTML additionally requires the
        // mounted caller runtime, while native Notes remain editable without it.
        // The controller owns that combined handler truth for every activation
        // surface (pointer, keyboard, screen reader and direct command).
        const supportsEdit = controller.supportsItemEdit(itemId);
        // A move needs a sibling to anchor against. At the ends of a view there is
        // none, so the direction is omitted rather than offered and ignored.
        const placementIndex = placements.findIndex((placement) => placement.itemId === itemId);
        // Resize, reorder, Move to view and Remove from this view all address a
        // PLACEMENT. A recovered item has none, so the layout owner would answer
        // every one of them `session_board_item_not_found`: they are absent here
        // and Pin is the operation that item actually has.
        const placed = placementIndex >= 0;
        const movable = placementIndex < 0
            ? null
            : { before: placementIndex > 0, after: placementIndex < placements.length - 1 };
        // The placement's frame override is shared (stored with the Board layout, like width); it
        // wins over this device's Appearance default for the Board.
        const frameOverride = placementIndex < 0 ? null : placements[placementIndex]?.frameStyle ?? null;
        const moveDestinations = !placed ? [] : snapshot.views
            .filter((candidate) => !candidate.synthetic
                && candidate.id !== activeView?.id
                && !candidate.placements.some((placement) => placement.itemId === itemId))
            // The move menu names a destination the person can recognise, so it uses
            // the same title resolver the view strip draws — a shared view title is
            // author copy that may be absent or blank, and `null` is not a label.
            .map((candidate) => ({ id: candidate.id, title: resolveSessionBoardViewTitle(candidate) }));
        const entityDrag: SessionSurfaceEntityBinding | null = dragScope && dragAddress && props.retained !== true && placed && activeView && !activeView.synthetic ? {
            scope: dragScope.scope,
            admitWidgetMovement,
            isCurrent: () => dragScope.isCurrent() && controller.snapshot?.itemsById.get(itemId)?.state.kind === 'ready'
                && controller.snapshot.views.some(view => view.id === activeView.id && view.placements.some(placement => placement.itemId === itemId)),
            title: projected.state.kind === 'ready' ? projected.state.item.title : itemId,
            getItem: () => ({ kind: 'session-board-item', scope: dragScope.scope, address: dragAddress, viewId: activeView.id, itemId }),
            keyboardDestination: (intent, selected, destinations) => {
                const live = controller.snapshot;
                const sourceView = live?.views.find(view => view.id === activeView.id);
                if (!sourceView) return null;
                if (intent === 'previous' || intent === 'next') return resolveSessionSurfaceKeyboardDestination({
                    itemKey: itemId, orderedKeys: sourceView.placements.map(placement => placement.itemId), selected, destinations, direction: intent,
                    readAnchor: destination => {
                        const parsed = SessionBoardDestinationSchema.safeParse(destination.destination);
                        return parsed.success && parsed.data.viewId === sourceView.id ? parsed.data : null;
                    },
                });
                const views = live?.views.filter(view => !view.synthetic) ?? [];
                const value = SessionBoardViewDestinationSchema.safeParse(selected?.destination);
                const selectedView = value.success ? value.data.viewId : activeView.id;
                const viewId = views[views.findIndex(view => view.id === selectedView) + (intent === 'in' ? 1 : -1)]?.id;
                return destinations.find(destination => {
                    const target = SessionBoardViewDestinationSchema.safeParse(destination.destination);
                    return target.success && target.data.viewId === viewId;
                }) ?? null;
            },
            getNativeBounds: () => {
                const viewport = readWindowBounds(sessionSurfaceMeasurable(scrollRef.current)) ?? scrollWindow.current;
                const rect = placementRects.current.get(itemId);
                return viewport && rect ? { ...rect, x: viewport.x + rect.x, y: viewport.y + gridContentY.current + rect.y - scrollOffsetY.current } : null;
            },
            ...(mutationControls && controller.supports('item.moveAnchored') ? {
                getBoardTarget: () => ({ surface: { ...dragScope.scope, owner: { kind: 'sessionBoard', sessionId: dragAddress.sessionId } },
                    tabId: activeView.id, itemId, itemIds: controller.snapshot?.views.find(view => view.id === activeView.id)?.placements.map(placement => placement.itemId) ?? [] }),
                pointerDestination: (bounds: WindowBounds, pointer: Readonly<{ x: number; y: number }>) => {
                    const carried = dragRuntime.getSnapshot().item;
                    if (carried?.kind !== 'session-board-item' || carried.address.sessionId !== dragAddress.sessionId) return { viewId: activeView.id, itemId, side: pointer.y < bounds.y + bounds.height / 2 ? 'before' : 'after' };
                    const viewport = readWindowBounds(sessionSurfaceMeasurable(scrollRef.current)) ?? scrollWindow.current;
                    const sourceRect = carried?.kind === 'session-board-item' ? placementRects.current.get(carried.itemId) : null;
                    if (!viewport || !sourceRect || carried?.kind !== 'session-board-item') return null;
                    const anchor = resolveSessionBoardAnchoredPointerDrop({ draggedId: carried.itemId,
                        orderedIds: controller.snapshot?.views.find(view => view.id === activeView.id)?.placements.map(placement => placement.itemId) ?? [],
                        itemRects: placementRects.current, droppedInside: true,
                        translationX: pointer.x - viewport.x - sourceRect.x - sourceRect.width / 2,
                        translationY: pointer.y - viewport.y - gridContentY.current + scrollOffsetY.current - sourceRect.y - sourceRect.height / 2 });
                    return anchor ? { ...anchor, viewId: activeView.id } : null;
                },
                target: { acceptedKinds: ['session-board-item', 'companion-item', 'home-section', 'work-board-widget', 'widget-area-instance'] as const,
                    containsPointer: pointer => {
                        const viewport = readWindowBounds(sessionSurfaceMeasurable(scrollRef.current)) ?? scrollWindow.current;
                        return !!viewport && pointer.y >= viewport.y && pointer.y <= viewport.y + viewport.height && pointer.x >= viewport.x && pointer.x <= viewport.x + viewport.width;
                    },
                    listDestinations: () => (['before', 'after'] as const).map(side => ({ destination: { side, itemId, viewId: activeView.id }, group: `${t('sessionBoard.views.label')} · ${resolveSessionBoardViewTitle(activeView)}`, label: t(side === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target: projected.state.kind === 'ready' ? projected.state.item.title : itemId }) })),
                    resolve: ({ item, destination }: Parameters<NonNullable<SessionSurfaceEntityBinding['target']>['resolve']>[0]) => {
                        const anchor = SessionBoardDestinationSchema.safeParse(destination);
                        return anchor.success ? resolveSessionBoardEntityDrop({ item, scope: dragScope.scope, address: dragAddress, board: controller.snapshot, viewId: activeView.id, anchor: anchor.data, widgetSourceRef: widgetMovement.sourceRef,
                            preview: { verb: t(anchor.data.side === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target: projected.state.kind === 'ready' ? projected.state.item.title : itemId }), target: projected.state.kind === 'ready' ? projected.state.item.title : itemId } }) : sessionSurfaceDropRefused('same-position');
                    },
                    execute: (effect: Parameters<typeof executeSessionBoardEntityDrop>[1]) => executeSessionBoardEntityDrop(controller, effect),
                    autoscroll: (pointer: Readonly<{ x: number; y: number }>) => { dragPointerContentY.value = pointer.y; },
                },
            } : {}),
        } : null;
        const movePlacement = (viewId: string, anchor?: Readonly<{ side: 'before' | 'after'; itemId: string }>) => {
            const item = entityDrag?.getItem();
            if (!item || !dragScope?.isCurrent() || !dragAddress) return;
            const admission = resolveSessionBoardEntityDrop({ item, scope: dragScope.scope, address: dragAddress,
                board: controller.snapshot, viewId, ...(anchor ? { anchor } : {}),
                preview: { verb: t('sessionBoard.item.moved.reordered', { title: itemId }), target: viewId } });
            if (admission.status === 'allowed') void executeSessionBoardEntityDrop(controller, admission.effect);
        };
        return (
            <SessionWidgetHost
                {...(entityDrag ? { entityDrag } : {})}
                expanded={expanded}
                sessionId={props.sessionId}
                serverId={props.serverId}
                {...(props.session ? { session: props.session } : {})}
                item={projected}
                host={props.host}
                primaryHost={props.resolvePrimaryHost(itemId)}
                // Navigation-only withholds authoring chrome (every mutating handler below
                // is gated on `mutationControls`); it does not decide executability.
                density={props.density}
                canEdit={mutationControls ? snapshot.canEdit : false}
                executableCurrentness={resolveSessionBoardExecutableCurrentness(
                    snapshot,
                    projected,
                    props.pluginRuntime,
                )}
                width={width}
                frameStyle={resolveWidgetFrameStyle({ placement: 'board', surfaceDefault: boardFrameDefault, override: frameOverride })}
                {...(arrivals.has(itemId) ? { fresh: true } : {})}
                {...(mutationControls && placed && controller.supports('item.frameStyle')
                    ? {
                        frameOverride: {
                            surfaceDefault: boardFrameDefault,
                            override: frameOverride,
                            onSet: (frameStyle: WidgetFrameStyle | null) => {
                                void controller.run({ kind: 'item.frameStyle', itemId, frameStyle });
                            },
                        },
                    }
                    : {})}
                heightBounds={heightBounds}
                {...(deferBody ? { deferBody: true } : {})}
                {...(controller.headingFocusRequest?.itemId === itemId
                    ? {
                        focusHeadingRequestId: controller.headingFocusRequest.requestId,
                        onHeadingFocusHandled: controller.acknowledgeHeadingFocus,
                    }
                    : {})}
                actionBinding={props.resolveActionBinding?.(itemId) ?? null}
                resolveSourceAvailability={controller.resolveSourceAvailability}
                {...(props.pluginRuntime ? { pluginRuntime: props.pluginRuntime } : {})}
                {...(props.callerHostedHtmlRuntime ? { callerHostedHtmlRuntime: props.callerHostedHtmlRuntime } : {})}
                {...(props.onReadFullItem ? { onReadFull: () => props.onReadFullItem?.(itemId) } : {})}
                {...(props.retained !== true
                    ? props.companionItemIds?.has(itemId)
                        ? props.onRemoveFromCompanion
                            ? { onRemoveFromCompanion: () => props.onRemoveFromCompanion?.(itemId) }
                            : {}
                        : props.onAddToCompanion
                            ? { onAddToCompanion: () => props.onAddToCompanion?.(itemId) }
                            : {}
                    : {})}
                {...(props.onOpenItemHere
                    ? { onOpenHere: () => props.onOpenItemHere?.(itemId) }
                    : {})}
                {...(mutationControls && controller.supports('item.remove')
                    ? { onRemove: () => { void controller.run({ kind: 'item.remove', itemId }); } }
                    : {})}
                {...(mutationControls && placed && controller.supports('item.unpin')
                    ? { onUnpin: () => { void controller.run({ kind: 'item.unpin', itemId }); } }
                    : {})}
                {...(mutationControls && supportsEdit ? { onEdit: () => { void controller.run({ kind: 'item.edit', itemId }); } } : {})}
                {...(mutationControls && controller.supports('item.rename')
                    ? { onRename: (title: string) => { void controller.run({ kind: 'item.rename', itemId, title }); } }
                    : {})}
                {...(mutationControls && controller.supports('item.inputs')
                    ? { onSetInputs: (bindings: WidgetInputBindingsV1) => runBoardWidgetSetupCommand(
                        () => controller.run({ kind: 'item.inputs', itemId, bindings }),
                        t('widgetAdd.saveFailed'),
                    ) }
                    : {})}
                {...(mutationControls && placed && controller.supports('item.resize')
                    ? { onResize: (next: SessionBoardItemWidth) => { void controller.run({ kind: 'item.resize', itemId, width: next }); } }
                    : {})}
                {...(mutationControls && controller.supports('item.height')
                    ? { onSetHeight: (height: SessionSurfaceItemV1['height']) => { void controller.run({ kind: 'item.height', itemId, height }); } }
                    : {})}
                {...(mutationControls && controller.supports('item.move') && movable
                    ? {
                        onMove: (direction: 'before' | 'after') => {
                            const current = controller.snapshot?.views.find(view => view.id === activeView?.id);
                            const at = current?.placements.findIndex(placement => placement.itemId === itemId) ?? -1;
                            const neighbor = at < 0 ? null : current?.placements[at + (direction === 'before' ? -1 : 1)];
                            if (current && neighbor) movePlacement(current.id, { side: direction, itemId: neighbor.itemId });
                        },
                        canMoveBefore: movable.before,
                        canMoveAfter: movable.after,
                    }
                    : {})}
                {...(mutationControls && controller.supports('item.moveToView') && moveDestinations.length > 0
                    ? {
                        moveDestinations,
                        onMoveToView: (viewId: string) => { movePlacement(viewId); },
                    }
                    : {})}
                {...(props.navigationOnly ? { openActionLabel: t('sessionBoard.sidebar.openInDetails') } : {})}
                {...(props.companionItemIds?.has(itemId) ? { inCompanion: true } : {})}
                {...(props.navigationOnly && props.onOpenItemHere
                    ? { onPressCard: () => props.onOpenItemHere?.(itemId) }
                    : {})}
                {...(mutationControls && controller.supports('item.managePlugin')
                    ? { onManagePlugin: () => { void controller.run({ kind: 'item.managePlugin', itemId }); } }
                    : {})}
                {...(mutationControls && controller.supports('item.prepareEncryption')
                    ? { onPrepareEncryption: () => { void controller.run({ kind: 'item.prepareEncryption' }); } }
                    : {})}
            />
        );
    };

    // The expanded item route: still inside Details, with a compact back
    // affordance and no modal or nested navigator of its own.
    const focusedItemId = props.focusedItemId ?? null;
    if (focusedItemId) {
        const focusedItem = resolveSessionBoardReferenceProjection(snapshot, focusedItemId);
        return (
            <View style={styles.root} testID={`${testID}-focused`}>
                {props.header}
                {mutationControls ? <MutationRecoveryNotice controller={controller} testID={testID} /> : null}
                {props.onLeaveFocusedItem ? (
                    <View style={styles.addRow}>
                        <RoundButton
                            size="small"
                            display="inverted"
                            testID={`${testID}-focused-back`}
                            title={t('sessionBoard.title')}
                            onPress={props.onLeaveFocusedItem}
                        />
                    </View>
                ) : null}
                <ScrollView style={styles.scroll} testID={`${testID}-focused-scroll`}>
                    <BoardItemArrival>
                        <View style={styles.single}>
                            {props.editor ? (
                                <View testID={`${testID}-focused-editor`}>{props.editor}</View>
                            ) : null}
                            {renderItem(focusedItemId, 'full', true, focusedItem)}
                        </View>
                    </BoardItemArrival>
                </ScrollView>
            </View>
        );
    }

    return (
        <View style={styles.root} testID={testID}>
            {!props.retained && !layoutCard && activeView && props.onBodyEligibilityChange ? (
                <BodyEligibility host={props.host} viewId={activeView.id}
                    itemIdsKey={[...bodyEligibleItemIds].join('\u001f')}
                    report={props.onBodyEligibilityChange} />
            ) : null}
            {props.header}
            {mutationControls ? <MutationRecoveryNotice controller={controller} testID={testID} /> : null}
            <View
                style={styles.viewsRow}
                ref={viewStripDrag.ref}
                onLayout={(event) => { viewsRowY.current = event.nativeEvent.layout.y; viewStripDrag.onLayout(event); }}
            >
                <View style={styles.viewsStrip}>
                    <SessionBoardViewStrip
                        views={snapshot.views}
                        activeViewId={controller.activeViewId}
                        removalFocusRequest={controller.viewRemovalFocusRequest}
                        onRemovalFocusHandled={controller.acknowledgeViewRemovalFocus}
                        tabIdPrefix={viewTabIdPrefix}
                        panelId={viewPanelId}
                        onSelectView={(viewId) => { void controller.run({ kind: 'view.select', viewId }); }}
                        onViewLayout={(viewId, event) => {
                            const { x, y, width, height } = event.nativeEvent.layout;
                            viewRects.current.set(viewId, { x, y, width, height });
                            dragRuntime.refresh();
                        }}
                        onHorizontalOffset={(offset) => { viewsHorizontalOffset.current = offset; dragRuntime.refresh(); }}
                        onViewFocusTargetChange={props.onViewFocusTargetChange}
                        focusFallbackRef={props.viewActionsFocusTargetRef}
                        {...(mutationControls ? {
                            renamingViewId,
                            onRenameCancel: () => setRenamingViewId(null),
                            onRenameCommit: (viewId: string, title: string) => {
                                setRenamingViewId(null);
                                void controller.run({ kind: 'view.rename', viewId, title });
                            },
                        } : {})}
                        testID={`${testID}-views`}
                    />
                </View>
                {mutationControls ? (
                    <ViewActions
                        controller={controller}
                        testID={testID}
                        onBeginRename={setRenamingViewId}
                        onFocusTargetChange={props.onViewActionsFocusTargetChange}
                    />
                ) : null}
            </View>
            {controller.announcement ? (
                <Text
                    testID={`${testID}-announcement`}
                    style={styles.freshness}
                    accessibilityLiveRegion="polite"
                    role="status"
                >
                    {controller.announcement}
                </Text>
            ) : null}
            {freshnessLabel ? (
                <SurfaceFreshnessLine
                    testID={`${testID}-freshness`}
                    reason={freshnessLabel}
                    tone={offline ? 'warning' : 'neutral'}
                />
            ) : null}
            {layoutCard ?? offlineEmptyCard ?? (
                <ScrollView
                    ref={scrollRef}
                    {...(snapshot.views.length > 1
                        ? {
                            nativeID: viewPanelId,
                            // `tabpanel` is an ARIA role, so it belongs on `role`;
                            // React Native's `accessibilityRole` union has no such
                            // value and silently dropped the panel relationship.
                            role: 'tabpanel' as const,
                            accessibilityLabelledBy: sessionBoardViewTabNativeId(viewTabIdPrefix, controller.activeViewId),
                            'aria-labelledby': sessionBoardViewTabNativeId(viewTabIdPrefix, controller.activeViewId),
                        }
                        : {})}
                    style={styles.scroll}
                    testID={`${testID}-scroll`}
                    scrollEventThrottle={16}
                    onLayout={(event) => {
                        scrollViewportY.current = event.nativeEvent.layout.y;
                        measureDragViewport();
                        scrollViewportHeight.value = event.nativeEvent.layout.height;
                        setMeasuredViewportHeight(event.nativeEvent.layout.height);
                    }}
                    onContentSizeChange={(_width, height) => {
                        scrollContentHeight.value = height;
                        restorePresentationPosition();
                    }}
                    onScroll={(event) => {
                        scrollOffsetY.current = event.nativeEvent.contentOffset.y;
                        scrollOffset.value = event.nativeEvent.contentOffset.y;
                        dragRuntime.refresh();
                        capturePresentationPosition(event.nativeEvent.contentOffset.y);
                        // Quantized by one minimum card height so a flick advances the
                        // body window once per card rather than once per frame.
                        const nextWindowTop = quantizeScrollOffset(event.nativeEvent.contentOffset.y, bodyWindowQuantum);
                        setBodyWindowTopOffset((current) => (current === nextWindowTop ? current : nextWindowTop));
                    }}
                >
                    {/* The sidebar's Open board lives in the pane header, not in a body row. */}
                    {props.host === 'mobileCockpit' && !boardEmpty ? (
                        <SearchHeader
                            testID={`${testID}-search`}
                            value={mobileQuery}
                            onChangeText={setMobileQuery}
                            placeholder={t('sessionBoard.mobile.searchPlaceholder')}
                        />
                    ) : null}
                    {props.editor}
                    {/*
                      * An open editor or picker owns the interaction layer of an
                      * EMPTY Board: its invitation controls are not simultaneously
                      * focusable beneath the card. A Board that already has content
                      * keeps rendering it — the editor is an insertion point above
                      * the grid, not a modal that hides the person's work.
                      *
                      * The invitation itself is the app's ONE empty-state tile, not
                      * a Board-local pair of centered Texts: the same glyph, measure,
                      * typography and font-scale behaviour every other empty surface
                      * in Happier already has.
                      */}
                    {boardEmpty ? (props.editor ? null : (
                        <>
                            {/*
                              * The card offers the two first steps (Ask the agent, Add a note); any
                              * other Add source stays reachable through the one Add chooser, which on
                              * the phone lives in the pane header.
                              */}
                            {mutationControls
                                && props.host !== 'mobileCockpit'
                                && controller.addIntents.some((intent) => intent !== 'note' && intent !== 'askAgent')
                                ? <AddControls controller={controller} testID={testID} {...addSource} />
                                : null}
                            <SurfaceStateCard
                                testID={`${testID}-empty`}
                                kind="empty"
                                iconName="squares-four"
                                title={snapshot.canEdit
                                    ? t('sessionBoard.empty.editor.title')
                                    : t('sessionBoard.empty.viewer.title')}
                                reason={snapshot.canEdit
                                    ? t('sessionBoard.empty.editor.description')
                                    : t('sessionBoard.empty.viewer.description')}
                                {...emptyBoardActions(controller, mutationControls)}
                            />
                        </>
                    )) : (
                        <>
                            {/* The Add affordance stays reachable once content exists (phone: in the header). */}
                            {mutationControls && props.host !== 'mobileCockpit'
                                ? <AddControls controller={controller} testID={testID} {...addSource} />
                                : null}
                            {visiblePlacements.length === 0 && visibleRecovered.length === 0 ? (
                                <EmptyState
                                    testID={`${testID}-empty-view`}
                                    icon={<Icon
                                        name={mobileQuery.trim() ? 'magnifying-glass' : 'squares-four'}
                                        size={32}
                                        color={theme.colors.text.secondary}
                                    />}
                                    title={mobileQuery.trim()
                                        ? t('common.noMatches')
                                        : t('sessionBoard.views.empty.title')}
                                    {...(mobileQuery.trim()
                                        ? {}
                                        : { subtitle: t('sessionBoard.views.empty.reason') })}
                                />
                            ) : (
                                <View
                                    testID={`${testID}-items`}
                                    style={props.layout === 'grid' ? styles.grid : styles.single}
                                    onLayout={onGridLayout}
                                >
                                    {visiblePlacements.map((placement) => {
                                        const width = itemWidthFor(placement.width);
                                        const deferBody = !bodyEligibleItemIds.has(placement.itemId);
                                        return (
                                            <View
                                                key={placement.itemId}
                                                testID={`${testID}-placement-${placement.itemId}`}
                                                style={width === null ? undefined : { width, minWidth: 0 }}
                                                onLayout={(event) => {
                                                    const { x, y, width: measuredWidth, height } = event.nativeEvent.layout;
                                                    recordItemRect(placementRects.current, placement.itemId, {
                                                        x,
                                                        y,
                                                        width: measuredWidth,
                                                        height,
                                                    });
                                                }}
                                            >
                                                {renderItem(placement.itemId, placement.width, false, undefined, deferBody)}
                                            </View>
                                        );
                                    })}
                                </View>
                            )}
                            {visibleRecovered.length > 0 ? (
                                <View
                                    testID={`${testID}-recovered`}
                                    onLayout={(event) => { recordSectionOrigin(recoveredSectionY, event.nativeEvent.layout.y); }}
                                >
                                    <View style={styles.section}>
                                        <Text style={styles.sectionTitle} accessibilityRole="header">
                                            {t('sessionBoard.recovered.title')}
                                        </Text>
                                        <Text style={styles.sectionBody}>{t('sessionBoard.recovered.description')}</Text>
                                    </View>
                                    <View
                                        testID={`${testID}-recovered-rows`}
                                        style={styles.single}
                                        onLayout={(event) => { recordSectionOrigin(recoveredRowsY, event.nativeEvent.layout.y); }}
                                    >
                                        {visibleRecovered.map((itemId) => (
                                            <View
                                                key={itemId}
                                                testID={`${testID}-recovered-row-${itemId}`}
                                                onLayout={(event) => {
                                                    const { x, y, width, height } = event.nativeEvent.layout;
                                                    recordItemRect(recoveredRects.current, itemId, { x, y, width, height });
                                                }}
                                            >
                                                {/*
                                                  * Recovery is a list like any other: a Board holding a
                                                  * hundred unplaced documents must not instantiate all of
                                                  * them, so these rows pass through the same body window.
                                                  */}
                                                {renderItem(itemId, 'full', false, undefined, !bodyEligibleItemIds.has(itemId))}
                                                {mutationControls && controller.supports('item.pin') ? (
                                                    <View style={styles.addRow}>
                                                        <RoundButton
                                                            size="small"
                                                            display="inverted"
                                                            testID={`${testID}-recovered-pin-${itemId}`}
                                                            title={t('sessionBoard.recovered.pin')}
                                                            onPress={() => { void controller.run({ kind: 'item.pin', itemId }); }}
                                                        />
                                                    </View>
                                                ) : null}
                                            </View>
                                        ))}
                                    </View>
                                </View>
                            ) : null}
                        </>
                    )}
                </ScrollView>
            )}
            <SessionSurfaceEntityFeedback kind="session-board-item" scope={dragScope?.scope ?? null} address={dragAddress} testID={`${testID}-move`} />
        </View>
    );
}
