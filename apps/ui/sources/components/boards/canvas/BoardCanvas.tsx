import * as React from 'react';
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle, Defs, Pattern, Rect } from 'react-native-svg';
import { WorkBoardActionInputSchemasV1 } from '@happier-dev/protocol/boards/actionsV1';
import type { WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { getWidgetSizeFootprintV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { describeHappierDropAnnouncement, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { EntityDragGripTrigger, EntityStagedMoveDock, useEntityStagedMoveHints } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { EntityDropSettledFeedback } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { EntityDragGripChooser } from '@/components/ui/treeDragDrop/ui/EntityDragGripChooser';
import { createEntityDragGestureAdapter, useEntityDragSource, useEntityDragSourceState, useEntityDragDomBinding,
    useEntityDropTargetState, type EntityDragCarry } from '@/components/ui/treeDragDrop';
import { t } from '@/text';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { BoardCardView } from '../cards/BoardCardView';
import type { BoardCard } from '../model/boardCards';
import type { BoardCardAction } from '../model/boardCardOpenTarget';
import { BOARD_CANVAS_METRICS, ceilToBoardCanvasGrid, moveBoardCardByKeyboard, resolveBoardCanvasColumnCount, resolveBoardCanvasPositions, type BoardCanvasDirection, type BoardCanvasPoint, type BoardCanvasRect } from '../model/boardCanvasGeometry';
import { readWorkBoardCanvasKeys, workBoardCanvasKey, workBoardDragItem, workBoardWidgetDragItem } from '../model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { useBoardCanvasEntityDrop } from './useBoardCanvasEntityDrop';
import { useEntityDragChooser } from '@/components/ui/treeDragDrop/useEntityDragChooser';
import { createNearViewportTracker, useIsNearViewport, type NearViewportSpan, type NearViewportTracker } from '@/components/widgets/nearViewport';

const { cardWidthPx, gapPx, paddingPx, gridStepPx } = BOARD_CANVAS_METRICS;
const ARROWS: Readonly<Record<string, BoardCanvasDirection>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const MOVE_ACTIONS = [{ name: 'moveUp', direction: 'up' }, { name: 'moveDown', direction: 'down' },
    { name: 'moveLeft', direction: 'left' }, { name: 'moveRight', direction: 'right' }] as const;
type CardRect = BoardCanvasRect;

/** A configured widget on the Canvas: its qualified placement key, and its title for the grip and announcements. */
export type BoardCanvasWidget = Readonly<{ key: string; title: string; placement: WorkBoardWidgetPlacementV1; size?: WidgetSizeV1 }>;

/** What the widget host draws: the shared frame, with the Canvas grip in its header. */
export type BoardCanvasWidgetRender = (widget: BoardCanvasWidget, state: Readonly<{ grip: React.ReactNode; lifted: boolean; active: boolean }>) => React.ReactNode;

/** One Canvas member: a work card, or a widget one or two card columns wide. Layout never branches on more than this. */
type CanvasMember =
    | Readonly<{ kind: 'work'; key: string; title: string; span: 1; card: BoardCard }>
    | Readonly<{ kind: 'widget'; key: string; title: string; span: 1 | 2; widget: BoardCanvasWidget }>;

/** Measured presentation only; retained by the open Board while phone By status replaces Canvas. */
export type BoardCanvasLayoutSnapshot = Readonly<{
    width: number;
    viewportHeight: number;
    heights: ReadonlyMap<string, number>;
    positions: ReadonlyMap<string, BoardCanvasPoint>;
}>;

export type BoardCanvasProps = Readonly<{
    cards: readonly BoardCard[];
    /** The Board's widgets, in Board order; drawn by `renderWidget`. */
    widgets?: readonly BoardCanvasWidget[];
    renderWidget?: BoardCanvasWidgetRender;
    /** The Board's mixed manual order (picked work and widgets); live section cards follow it. */
    order?: readonly string[];
    positionsByItemRef: Readonly<Record<string, BoardCanvasPoint>>;
    snap: boolean;
    binding: WorkBoardEntityBinding;
    retainedLayout?: React.RefObject<BoardCanvasLayoutSnapshot | null>;
    placingKey?: string | null;
    onPlaced?: () => void;
    onOpen: (card: BoardCard) => void;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
}>;

const NO_WIDGETS: readonly BoardCanvasWidget[] = Object.freeze([]);

function memberWidthPx(span: 1 | 2): number {
    return span === 2 ? cardWidthPx * 2 + gapPx : cardWidthPx;
}

/** Saved XY and flow are layout; the shared entity owner admits and commits every move. */
export const BoardCanvas = React.memo(function BoardCanvas(props: BoardCanvasProps) {
    const [width, setWidth] = React.useState(() => props.retainedLayout?.current?.width ?? 0);
    const [viewportHeight, setViewportHeight] = React.useState(() => props.retainedLayout?.current?.viewportHeight ?? 0);
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
    const measured = React.useRef(new Map<string, BoardCanvasRect>());
    const [heights, setHeights] = React.useState<ReadonlyMap<string, number>>(() => props.retainedLayout?.current?.heights ?? new Map());
    const previousPositions = React.useRef<ReadonlyMap<string, BoardCanvasPoint>>(props.retainedLayout?.current?.positions ?? new Map());
    const previousMembers = React.useRef<readonly CanvasMember[]>([]);
    const canvas = useBoardCanvasEntityDrop(props.binding, measured, props.snap);
    // The existing Canvas grid is the quantization boundary; Home's owner supplies demand overscan.
    const [verticalDemand] = React.useState(() => createNearViewportTracker({ quantum: gridStepPx, initialViewportHeight: viewportHeight }));
    const [horizontalDemand] = React.useState(() => createNearViewportTracker({ quantum: gridStepPx, initialViewportHeight: width, axis: 'x' }));
    const columnCount = resolveBoardCanvasColumnCount(Math.max(0, width - paddingPx * 2));
    const widgets = props.widgets ?? NO_WIDGETS;
    const members = React.useMemo(() => {
        const prior = new Map(previousMembers.current.map(member => [member.key, member]));
        const next: CanvasMember[] = [
            ...props.cards.map((card): CanvasMember => ({ kind: 'work', key: card.key, title: card.title, span: 1, card })),
            ...widgets.map((widget): CanvasMember => ({ kind: 'widget', key: widget.key, title: widget.title,
                span: getWidgetSizeFootprintV1('workBoard', widget.size ?? widget.placement.size)?.columnSpan === 2 ? 2 : 1, widget })),
        ].map(member => {
            const old = prior.get(member.key);
            return old?.kind === 'work' && member.kind === 'work' && old.card === member.card ? old
                : old?.kind === 'widget' && member.kind === 'widget' && old.widget === member.widget && old.span === member.span ? old : member;
        });
        if (!props.order?.length) return next;
        // The Board's manual order first (picked work and widgets, mixed); live section cards keep theirs after it.
        const rank = new Map(props.order.map((key, index) => [key, index] as const));
        return next.map((member, index) => ({ member, index }))
            .sort((a, b) => (rank.get(a.member.key) ?? props.order!.length + a.index) - (rank.get(b.member.key) ?? props.order!.length + b.index))
            .map(entry => entry.member);
    }, [props.cards, props.order, widgets]);
    const drawingMembers = React.useMemo(() => members.map(member => member.span === 2 && columnCount === 1
        && props.positionsByItemRef[member.key] === undefined ? { ...member, span: 1 as const } : member), [members, columnCount, props.positionsByItemRef]);
    const positions = React.useMemo(() => {
        // Measure hidden frames first; never guess a height from a card's kind or duplicate its body rules.
        const ready = width > 0 && members.every(member => heights.has(member.key));
        return resolveBoardCanvasPositions({ members: drawingMembers.filter(member => heights.has(member.key)
            && (ready || previousPositions.current.has(member.key) || props.positionsByItemRef[member.key] !== undefined)).map(member => ({ key: member.key,
                width: memberWidthPx(member.span), height: heights.get(member.key)! })),
            positionsByItemRef: props.positionsByItemRef, columnCount, snap: props.snap, previous: previousPositions.current });
    }, [drawingMembers, members, heights, props.positionsByItemRef, columnCount, props.snap, width]);
    React.useLayoutEffect(() => {
        previousPositions.current = positions; previousMembers.current = members;
        if (props.retainedLayout) props.retainedLayout.current = { width, viewportHeight, heights, positions };
    }, [positions, members, props.retainedLayout, width, viewportHeight, heights]);
    const reportRect = React.useCallback((key: string, rect: CardRect | null) => {
        if (rect) measured.current.set(key, rect);
        else measured.current.delete(key);
        setHeights(previous => {
            if (rect ? previous.get(key) === rect.height : !previous.has(key)) return previous;
            const next = new Map(previous);
            if (rect) next.set(key, rect.height); else next.delete(key);
            return next;
        });
    }, []);
    let contentHeight = 0, memberRight = 0;
    for (const member of drawingMembers) {
        const point = positions.get(member.key) ?? props.positionsByItemRef[member.key];
        if (!point) continue;
        contentHeight = Math.max(contentHeight, point.y + (heights.get(member.key) ?? 0));
        memberRight = Math.max(memberRight, point.x + memberWidthPx(member.span));
    }
    const contentWidth = Math.max(width, memberRight + paddingPx * 2);
    const cardProps = { binding: props.binding, canvas, onOpen: props.onOpen, onAction: props.onAction, renderWidget: props.renderWidget,
        verticalDemand, horizontalDemand, onReportRect: reportRect, onPlaced: props.onPlaced, onFocused: setFocusedKey };
    return <View style={styles.scroll}>
        <ScrollView ref={canvas.viewportRef} testID="board-canvas" style={styles.scroll} contentContainerStyle={styles.scrollContent}
            onLayout={(event: LayoutChangeEvent) => { setWidth(event.nativeEvent.layout.width); setViewportHeight(event.nativeEvent.layout.height); verticalDemand.onLayout(event); horizontalDemand.onLayout(event); canvas.refresh(); }}
            onScroll={event => { verticalDemand.onScroll(event); canvas.refresh(); }} scrollEventThrottle={16}>
            <ScrollView testID="board-canvas-horizontal" horizontal contentContainerStyle={{ width: contentWidth }}
                onScroll={event => { horizontalDemand.onScroll(event); canvas.refresh(); }} scrollEventThrottle={16}>
                <View ref={canvas.contentRef} collapsable={false} onLayout={canvas.refresh}
                    style={[styles.content, { width: contentWidth, minHeight: Math.max(contentHeight + paddingPx * 2, viewportHeight) }]}>
                    {props.snap ? <CanvasDotGrid /> : null}
                    <CanvasSnapFeedback binding={props.binding} canvas={canvas} members={drawingMembers} heights={heights} />
                    {drawingMembers.map(member => <CanvasCard key={member.key} {...cardProps} member={member}
                        position={positions.get(member.key) ?? props.positionsByItemRef[member.key] ?? null}
                        measuredHeight={heights.get(member.key)}
                        positioned={positions.has(member.key)} saved={props.positionsByItemRef[member.key] !== undefined}
                        placing={props.placingKey === member.key} restoreFocus={focusedKey === member.key} />)}
                </View>
            </ScrollView>
        </ScrollView>
        <CanvasMoveFeedback binding={props.binding} targetId={canvas.targetId} />
    </View>;
});

const CanvasCard = React.memo(function CanvasCard(props: Readonly<{
    member: CanvasMember; position: BoardCanvasPoint | null; measuredHeight: number | undefined;
    positioned: boolean; saved: boolean; placing: boolean; restoreFocus: boolean;
    binding: WorkBoardEntityBinding; canvas: ReturnType<typeof useBoardCanvasEntityDrop>;
    onOpen: (card: BoardCard) => void; onPlaced?: () => void;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
    renderWidget?: BoardCanvasWidgetRender;
    verticalDemand: NearViewportTracker; horizontalDemand: NearViewportTracker;
    onReportRect: (key: string, rect: CardRect | null) => void;
    onFocused: (key: string) => void;
}>) {
    const { member, binding, canvas } = props;
    // The status word follows a work card's title; a widget says what it is.
    const spoken = member.kind === 'work' ? member.card.status.word : t('boards.widgets.kind');
    const { runtime } = binding;
    const sourceId = 'work-board-card:' + React.useId();
    const pressable = React.useRef<Readonly<{ focus: () => void }> | null>(null);
    const latest = React.useRef(props); latest.current = props;
    const origin = React.useRef<BoardCanvasPoint>(props.position ?? { x: 0, y: 0 });
    const settleTarget = React.useRef<BoardCanvasPoint | null>(null);
    const staged = React.useRef<BoardCanvasPoint | null>(null);
    const carry = React.useRef<EntityDragCarry | null>(null);
    const adapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const translateX = useSharedValue(0), translateY = useSharedValue(0);
    const state = useEntityDragSourceState(runtime, sourceId);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const chooser = useEntityDragChooser(runtime, sourceId, () => latest.current.onPlaced?.());
    const chooserOpen = chooser.open;
    const destinations = chooser.destinations;
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? t('entityDragDrop.organize.title'), group: destination.group,
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    useEntityDragSource(runtime, { id: sourceId, scope: binding.scope, isCurrent: () => latest.current.binding.isCurrent()
        && readWorkBoardCanvasKeys(latest.current.binding.getContext()).includes(latest.current.member.key),
        getItem: () => {
            const current = latest.current.member;
            const { scope } = latest.current.binding;
            const boardId = latest.current.binding.getContext().board.id;
            return current.kind === 'work' ? workBoardDragItem(scope, boardId, current.card.ref)
                : workBoardWidgetDragItem(scope, boardId, current.widget.placement.instance.id);
        },
        describe: () => ({ title: latest.current.member.title,
            subtitle: latest.current.member.kind === 'work' ? latest.current.member.card.status.word : t('boards.widgets.kind') }),
    });
    const hoverCapablePrimaryPointer = useHoverCapablePrimaryPointer();
    const dom = useEntityDragDomBinding({ runtime, sourceId, enabled: hoverCapablePrimaryPointer, describe: () => latest.current.member.title,
        canStart: (event, host) => {
            const element = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
            const control = element?.closest('button,input,textarea,a,[role="button"],[contenteditable="true"]');
            if (control && control !== host) return false;
            if (typeof window !== 'undefined' && window.getSelection()?.toString()) return false;
            canvas.setGrab(member.key, { x: event.clientX, y: event.clientY });
            return true;
        } });
    const ref = React.useCallback((node: Readonly<{ focus: () => void }> | null) => { pressable.current = node; dom(node); }, [dom]);
    React.useLayoutEffect(() => {
        if (!props.position) return;
        const previous = origin.current;
        origin.current = props.position;
        if (previous.x === props.position.x && previous.y === props.position.y) return;
        // Rebase the carried/settling visual when the acknowledged position reaches the renderer.
        cancelAnimation(translateX); cancelAnimation(translateY);
        translateX.value += previous.x - props.position.x;
        translateY.value += previous.y - props.position.y;
        const target = settleTarget.current;
        if (target) {
            const x = target.x - props.position.x, y = target.y - props.position.y;
            translateX.value = readReducedMotionPreference() ? x : withSpring(x, reanimatedMotionTokens.spring.travel);
            translateY.value = readReducedMotionPreference() ? y : withSpring(y, reanimatedMotionTokens.spring.travel);
        } else if (!state.active) { translateX.value = 0; translateY.value = 0; }
    }, [props.position, state.active, translateX, translateY]);
    React.useEffect(() => { if (props.placing) pressable.current?.focus?.(); }, [props.placing]);
    // Saving a position retains the card and its focus; return grip focus to the card on that intent.
    const wasSaved = React.useRef(props.saved);
    React.useEffect(() => {
        if (props.saved && !wasSaved.current && latest.current.restoreFocus) pressable.current?.focus?.();
        wasSaved.current = props.saved;
    }, [props.saved]);
    React.useEffect(() => () => { adapter.current?.cancel(); carry.current?.cancel('source-retired'); props.onReportRect(member.key, null); }, [member.key, props.onReportRect]);
    // Numeric motion updates only this carried card; the canvas never subscribes to pointer frames.
    React.useEffect(() => {
        let wasSource = false;
        const settle = (point: BoardCanvasPoint) => {
            if (settleTarget.current?.x === point.x && settleTarget.current.y === point.y) return;
            settleTarget.current = point;
            cancelAnimation(translateX); cancelAnimation(translateY);
            const x = point.x - origin.current.x, y = point.y - origin.current.y;
            translateX.value = readReducedMotionPreference() ? x : withSpring(x, reanimatedMotionTokens.spring.travel);
            translateY.value = readReducedMotionPreference() ? y : withSpring(y, reanimatedMotionTokens.spring.travel);
        };
        const update = () => {
            const snapshot = runtime.getSnapshot();
            if (snapshot.sourceId !== sourceId || snapshot.phase === 'idle') {
                if (!wasSource) return;
                wasSource = false;
                staged.current = null;
                settle(latest.current.position ?? origin.current);
                return;
            }
            wasSource = true;
            const parsed = snapshot.admission?.status === 'allowed'
                ? WorkBoardActionInputSchemasV1['boards.apply'].safeParse(snapshot.admission.effect.input) : null;
            const admitted = parsed?.success && parsed.data.intent.kind === 'set_positions'
                ? parsed.data.intent.positionsByItemRef[member.key] : null;
            if (snapshot.phase === 'settled') {
                staged.current = null;
                settle(snapshot.outcome?.status === 'applied'
                    ? latest.current.binding.getContext().board.positionsByItemRef[member.key] ?? admitted ?? origin.current
                    : latest.current.position ?? origin.current);
                return;
            }
            if (snapshot.phase === 'pending') { if (admitted) settle(admitted); return; }
            const pointer = runtime.getPointer();
            const point = pointer ? canvas.readCarryPoint(member.key, pointer) : admitted;
            if (!point) return;
            if (settleTarget.current) { cancelAnimation(translateX); cancelAnimation(translateY); }
            settleTarget.current = null;
            translateX.value = point.x - origin.current.x; translateY.value = point.y - origin.current.y;
        };
        const unsubscribe = runtime.subscribe(update), unsubscribePointer = runtime.subscribePointer(update);
        return () => { unsubscribe(); unsubscribePointer(); cancelAnimation(translateX); cancelAnimation(translateY); };
    }, [runtime, sourceId, member.key, canvas, translateX, translateY]);
    const gesture = React.useMemo(() => Gesture.Pan().enabled(Platform.OS !== 'web').runOnJS(true).minDistance(4)
        .onStart(event => {
            canvas.setGrab(member.key, { x: event.absoluteX, y: event.absoluteY });
            const handle = runtime.begin(sourceId, 'pointer');
            adapter.current = handle ? createEntityDragGestureAdapter(handle) : null;
            adapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
        })
        .onUpdate(event => adapter.current?.update({ x: event.absoluteX, y: event.absoluteY }))
        .onEnd((event, success) => { void adapter.current?.end(success, { x: event.absoluteX, y: event.absoluteY }); })
        .onFinalize(() => adapter.current?.finalize()), [runtime, sourceId, canvas, member.key]);
    const move = (direction: BoardCanvasDirection, stage: boolean) => {
        const current = latest.current.binding.getContext().board.positionsByItemRef[member.key] ?? origin.current;
        const next = moveBoardCardByKeyboard(staged.current ?? current, direction);
        if (stage) { staged.current = next; carry.current?.choose(canvas.targetId, next); }
        else void runtime.perform(sourceId, canvas.targetId, next, 'action').then(outcome => {
            if (outcome?.status !== 'applied') return;
            const admitted = latest.current.binding.getContext().board.positionsByItemRef[member.key] ?? next;
            announceAccessibilityMessage(t('boards.card.moved', { x: Math.round(admitted.x / gridStepPx), y: Math.round(admitted.y / gridStepPx) }));
            latest.current.onPlaced?.();
        });
    };
    const onKeyDown = (event: { key?: string; repeat?: boolean; shiftKey?: boolean; nativeEvent?: { key?: string; shiftKey?: boolean }; preventDefault?: () => void; stopPropagation?: () => void }): boolean => {
        if (chooser.onMenuKeyDown(event)) return true;
        const key = event.key ?? event.nativeEvent?.key ?? '';
        const active = runtime.getSnapshot().sourceId === sourceId && runtime.getSnapshot().phase === 'carrying';
        // XY arrows are physical directions, not logical sibling order in an RTL list.
        const intent = resolveHappierStagedMoveKey({ key, repeat: event.repeat, staged: active, rtl: false });
        if (intent === 'pickUp') { event.preventDefault?.(); event.stopPropagation?.(); staged.current = null; carry.current = runtime.begin(sourceId, 'keyboard'); }
        else if (intent === 'cancel') { event.preventDefault?.(); event.stopPropagation?.(); carry.current?.cancel('keyboard-escape'); carry.current = null; staged.current = null; }
        else if (intent === 'drop') {
            event.preventDefault?.(); event.stopPropagation?.();
            void carry.current?.release().then(outcome => { if (outcome?.status === 'applied') latest.current.onPlaced?.(); }); carry.current = null;
        } else if (ARROWS[key]) { event.preventDefault?.(); event.stopPropagation?.(); move(ARROWS[key]!, active); }
        else return false;
        return true;
    };
    const ownLayout = React.useRef<Readonly<{ y: number; height: number }> | null>(null);
    const [gridInset, setGridInset] = React.useState(0);
    // Canvas already retains this geometry across the phone replacement. Demand
    // uses it in the first render, before the next asynchronous layout event.
    const positionY = props.position?.y;
    const span = React.useMemo<NearViewportSpan | null>(() => positionY !== undefined && props.measuredHeight !== undefined
        ? { top: paddingPx + positionY, height: props.measuredHeight } : null,
    [positionY, props.measuredHeight]);
    const report = () => {
        const layout = ownLayout.current;
        if (!layout) return;
        const point = latest.current.position ?? { x: 0, y: 0 };
        latest.current.onReportRect(member.key, { ...point, width: memberWidthPx(member.span),
            height: member.kind === 'work' ? ceilToBoardCanvasGrid(layout.height) : layout.height }); canvas.refresh();
    };
    const onLayout = (event: LayoutChangeEvent) => {
        // Remove the previous inset before quantizing the current content, so a shorter refresh
        // can shed padding instead of retaining its former frame height.
        const height = event.nativeEvent.layout.height - gridInset;
        ownLayout.current = { y: event.nativeEvent.layout.y, height };
        if (member.kind === 'work') setGridInset(ceilToBoardCanvasGrid(height) - height);
        report();
    };
    React.useLayoutEffect(report, [props.position]);
    const lifted = state.active || props.placing;
    // Picking a card up raises it a breath off the Canvas and setting it down sinks it back, on the same
    // spring as its travel, so lift, carry and settle read as one motion. Reduced motion keeps only the shadow.
    const liftScale = useSharedValue(1);
    React.useEffect(() => {
        const target = lifted && !readReducedMotionPreference() ? motionTokens.drag.liftScale : 1;
        if (liftScale.value === target) return;
        liftScale.value = readReducedMotionPreference() ? target : withSpring(target, reanimatedMotionTokens.spring.travel);
    }, [lifted, liftScale]);
    const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: liftScale.value }] }));
    const keyboardProps = Platform.OS === 'web' ? { onKeyDown, 'aria-grabbed': state.active } : {};
    const moveActions = MOVE_ACTIONS.map(action => ({ name: action.name, label: t(`boards.card.moveActions.${action.direction}`) }));
    const onMoveAction = (event: { nativeEvent: { actionName: string } }) => {
        const action = MOVE_ACTIONS.find(candidate => candidate.name === event.nativeEvent.actionName);
        if (action) move(action.direction, false);
    };
    const grip = <EntityDragGripChooser open={chooserOpen} onOpenChange={chooser.onOpenChange} closeOnSelect={false} sections={sections}
        onSelect={id => chooser.select(destinations[Number(id)])}
        trigger={({ toggle }) => <GestureDetector gesture={gesture}><EntityDragGripTrigger testID={'board-canvas-organize:' + member.key}
            accessibilityLabel={t('entityDragDrop.organize.grip', { item: member.title })}
            accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
            onFocusChange={focused => { setFocused(focused); if (focused) props.onFocused(member.key); }}
            // A widget's body has its own controls, so no card-wide button: its grip takes focus, the grid moves and the drag.
            {...(member.kind === 'widget' ? { controlRef: ref, accessibilityActions: moveActions, onAccessibilityAction: onMoveAction } : {})}
            onPress={toggle} onKeyDown={onKeyDown} expanded={chooserOpen} active={state.active}
                revealed={member.kind === 'widget' || !hoverCapablePrimaryPointer || hovered || focused || chooserOpen}
            /></GestureDetector>} />;
    const width = memberWidthPx(member.span);
    return <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onLayout={onLayout}
        pointerEvents={props.positioned ? 'auto' : 'none'} accessibilityElementsHidden={!props.positioned}
        importantForAccessibility={props.positioned ? 'auto' : 'no-hide-descendants'}
        style={[styles.placed, { width, left: paddingPx + (props.position?.x ?? 0), top: paddingPx + (props.position?.y ?? 0), opacity: props.positioned ? 1 : 0 }]}>
        <Animated.View style={[dragStyle, state.active ? styles.dragging : null]}>
            {member.kind === 'work' ? <View style={styles.cardFrame}>
                {/* The card's open target and its action are siblings inside one frame, never a button in a button. */}
                <BoardCardView card={member.card} lifted={lifted} onAction={props.onAction} actionsDisabled={state.active} grip={grip}
                    renderTarget={content => <Pressable ref={ref} testID={'board-canvas-card:' + member.key} accessibilityRole="button"
                        style={[styles.cardBody, { paddingBottom: gridInset }]} onFocus={() => { setFocused(true); props.onFocused(member.key); }} onBlur={() => setFocused(false)}
                        accessibilityLabel={member.title + ', ' + spoken} accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
                        accessibilityActions={moveActions} onAccessibilityAction={onMoveAction}
                        onPress={() => { if (!state.active) props.onOpen(member.card); }} {...keyboardProps}>
                        {content}
                    </Pressable>} />
            </View> : <View testID={'board-canvas-widget:' + member.key}>
                <CanvasWidgetBody widget={member.widget} span={span} left={paddingPx + (props.position?.x ?? 0)} width={width}
                    verticalDemand={props.verticalDemand} horizontalDemand={props.horizontalDemand}
                    renderWidget={props.renderWidget} grip={grip} lifted={lifted} focused={focused} />
            </View>}
        </Animated.View>
    </View>;
});

/** Only widget bodies subscribe to demand windows; work cards keep their existing render lifetime. */
function CanvasWidgetBody(props: Readonly<{
    widget: BoardCanvasWidget; span: NearViewportSpan | null; left: number; width: number;
    verticalDemand: NearViewportTracker; horizontalDemand: NearViewportTracker;
    renderWidget?: BoardCanvasWidgetRender; grip: React.ReactNode; lifted: boolean; focused: boolean;
}>) {
    const verticalNear = useIsNearViewport(props.verticalDemand, props.span);
    const horizontalSpan = React.useMemo(() => ({ top: props.left, height: props.width }), [props.left, props.width]);
    const horizontalNear = useIsNearViewport(props.horizontalDemand, horizontalSpan);
    return <>{props.renderWidget?.(props.widget, { grip: props.grip, lifted: props.lifted,
        active: (verticalNear && horizontalNear) || props.focused || props.lifted }) ?? null}</>;
}

function CanvasMoveFeedback(props: Readonly<{ binding: WorkBoardEntityBinding; targetId: string }>) {
    const selected = useEntityDropTargetState(props.binding.runtime, props.targetId);
    const hints = useEntityStagedMoveHints();
    const staged = selected && props.binding.runtime.getPointer() === null && (selected.phase === 'carrying' || selected.phase === 'pending') ? selected : null;
    const outcome = staged ? describeEntityDropOutcome(staged) : null;
    const latest = React.useRef(props); latest.current = props;
    // A move the Board owner refused late or could not confirm stays here in words (lab ST4).
    const settledMatch = React.useMemo(() => ({ item: (item: EntityDragItemV1) => (item.kind === 'work-board-item' || item.kind === 'work-board-widget')
        && item.boardId === latest.current.binding.getContext().board.id }), []);
    return <EntityDropSettledFeedback runtime={props.binding.runtime} match={settledMatch} testID="board-canvas-move">
        {outcome ? <EntityStagedMoveDock outcome={outcome} hints={hints} testID="board-canvas-move-preview" /> : null}
        <PoliteAccessibilityStatus announcement={describeHappierDropAnnouncement(outcome)} transitionKey={JSON.stringify(staged?.admission ?? null)} statusTestID="board-canvas-move-status" />
    </EntityDropSettledFeedback>;
}

/** Semantic destination feedback is separate from the card's numeric pointer-frame subscription. */
function CanvasSnapFeedback(props: Readonly<{
    binding: WorkBoardEntityBinding; canvas: ReturnType<typeof useBoardCanvasEntityDrop>;
    members: readonly CanvasMember[]; heights: ReadonlyMap<string, number>;
}>) {
    const selected = useEntityDropTargetState(props.binding.runtime, props.canvas.targetId);
    const snapping = React.useSyncExternalStore(props.canvas.subscribeSnapping, props.canvas.readSnapping, props.canvas.readSnapping);
    if (!snapping || !selected?.item || selected.phase !== 'carrying' || props.binding.runtime.getPointer() === null
        || selected.admission?.status !== 'allowed') return null;
    const parsed = WorkBoardActionInputSchemasV1['boards.apply'].safeParse(selected.admission.effect.input);
    const key = workBoardCanvasKey(selected.item, props.binding.getContext().board);
    const member = props.members.find(member => member.key === key);
    const point = key && parsed.success && parsed.data.intent.kind === 'set_positions' ? parsed.data.intent.positionsByItemRef[key] : null;
    if (!point || !member) return null;
    const left = paddingPx + point.x, top = paddingPx + point.y;
    return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.snapFeedback}>
        <View testID="board-canvas-snap-guide-x" style={[styles.guideX, { left }]} />
        <View testID="board-canvas-snap-guide-y" style={[styles.guideY, { top }]} />
        <View testID="board-canvas-snap-target" style={[styles.snapTarget, { left, top, width: memberWidthPx(member.span), height: props.heights.get(member.key) ?? 0 }]}>
            {/* Hangs from the slot's top-left corner, where the guides cross (lab `boards-B1s`). */}
            <View style={styles.snapLabel}><Text style={styles.snapLabelText}>{t('boards.canvas.snapsHere')}</Text></View>
        </View>
    </View>;
}

/**
 * The snap lattice, drawn (lab `dashboards` L1, `sessions-orchestration` canvas): one ink dot on every
 * grid step, so a free canvas reads as a surface things settle onto. Decorative, under the cards,
 * hidden from assistive tech; it scrolls with the content because it is the content's own grid.
 */
function CanvasDotGrid(): React.ReactElement {
    const { theme } = useUnistyles();
    return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.dotGrid}>
        <Svg width="100%" height="100%">
            <Defs>
                <Pattern id="board-canvas-dots" x={-gridStepPx / 2} y={-gridStepPx / 2} width={gridStepPx} height={gridStepPx} patternUnits="userSpaceOnUse">
                    <Circle cx={gridStepPx / 2} cy={gridStepPx / 2} r={1} fill={theme.colors.border.strong} />
                </Pattern>
            </Defs>
            <Rect x={0} y={0} width="100%" height="100%" fill="url(#board-canvas-dots)" />
        </Svg>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    dotGrid: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    scroll: { flex: 1 }, scrollContent: { flexGrow: 1 }, content: { position: 'relative' },
    placed: { position: 'absolute' }, dragging: { zIndex: 10 },
    cardFrame: { position: 'relative' }, cardBody: { alignSelf: 'stretch' },
    snapFeedback: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    // Guides are dashed hairlines in the focus ink: alignment help that reads as a hint, not as content.
    guideX: { position: 'absolute', top: 0, bottom: 0, width: 0, borderLeftWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.border.focus },
    guideY: { position: 'absolute', left: 0, right: 0, height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.border.focus },
    snapTarget: { position: 'absolute', borderWidth: 1, borderColor: theme.colors.border.focus, borderStyle: 'dashed', borderRadius: theme.borderRadius.xl },
    // `left: -1` is the slot's own border width, so the chip's edge meets the outline's.
    snapLabel: { position: 'absolute', left: -1, bottom: '100%', marginBottom: theme.space.s4,
        paddingHorizontal: theme.space.s8, borderRadius: theme.borderRadius.sm,
        borderWidth: 1, borderColor: theme.colors.border.focus, backgroundColor: theme.colors.surface.elevated },
    snapLabelText: { ...Typography.variant('meta'), ...Typography.default('semiBold'), color: theme.colors.border.focus },
}));
