import * as React from 'react';
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { WorkBoardActionInputSchemasV1, type WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';
import { describeHappierDropAnnouncement, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { EntityDragGripTrigger, EntityStagedMoveDock, useEntityStagedMoveHints } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { EntityDropSettledFeedback } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createEntityDragGestureAdapter, useEntityDragSource, useEntityDragSourceState, useEntityDragDomBinding,
    useEntityDropTargetState, type EntityDragCarry } from '@/components/ui/treeDragDrop';
import { t } from '@/text';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { BoardCardView } from '../cards/BoardCardView';
import type { BoardCard } from '../model/boardCards';
import { BOARD_CANVAS_METRICS, moveBoardCardByKeyboard, resolveBoardCanvasColumnCount, type BoardCanvasDirection, type BoardCanvasPoint } from '../model/boardCanvasGeometry';
import { readWorkBoardCanvasKeys, workBoardDragItem, workBoardWidgetDragItem } from '../model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { useBoardCanvasEntityDrop } from './useBoardCanvasEntityDrop';
import { useEntityDragChooser } from '@/components/ui/treeDragDrop/useEntityDragChooser';
import { createNearViewportTracker, useIsNearViewport, type NearViewportSpan, type NearViewportTracker } from '@/components/widgets/nearViewport';

const { cardWidthPx, gapPx, paddingPx, gridStepPx } = BOARD_CANVAS_METRICS;
const ARROWS: Readonly<Record<string, BoardCanvasDirection>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const MOVE_ACTIONS = [{ name: 'moveUp', direction: 'up' }, { name: 'moveDown', direction: 'down' },
    { name: 'moveLeft', direction: 'left' }, { name: 'moveRight', direction: 'right' }] as const;
type Rect = Readonly<{ x: number; y: number; height: number }>;

/** A configured widget on the Canvas: its qualified placement key, and its title for the grip and announcements. */
export type BoardCanvasWidget = Readonly<{ key: string; title: string; placement: WorkBoardWidgetPlacementV1 }>;

/** What the widget host draws: the shared frame, with the Canvas grip in its header. */
export type BoardCanvasWidgetRender = (widget: BoardCanvasWidget, state: Readonly<{ grip: React.ReactNode; lifted: boolean; active: boolean }>) => React.ReactNode;

/** One Canvas member: a work card, or a widget one or two card columns wide. Layout never branches on more than this. */
type CanvasMember =
    | Readonly<{ kind: 'work'; key: string; title: string; span: 1; card: BoardCard }>
    | Readonly<{ kind: 'widget'; key: string; title: string; span: 1 | 2; widget: BoardCanvasWidget }>;

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
    placingKey?: string | null;
    onPlaced?: () => void;
    onOpen: (card: BoardCard) => void;
}>;

const NO_WIDGETS: readonly BoardCanvasWidget[] = Object.freeze([]);

function memberWidthPx(span: 1 | 2): number {
    return span === 2 ? cardWidthPx * 2 + gapPx : cardWidthPx;
}

/** Flow (unplaced) members: runs of one-column cards share masonry columns; a two-column widget takes its own band. */
type FlowBlock = Readonly<{ kind: 'columns'; columns: CanvasMember[][] }> | Readonly<{ kind: 'wide'; member: CanvasMember }>;

function layoutFlow(members: readonly CanvasMember[], columnCount: number): readonly FlowBlock[] {
    const blocks: FlowBlock[] = [];
    let run: { columns: CanvasMember[][]; count: number } | null = null;
    for (const member of members) {
        if (member.span === 2 && columnCount >= 2) {
            blocks.push({ kind: 'wide', member });
            run = null;
            continue;
        }
        if (!run) {
            run = { columns: Array.from({ length: columnCount }, () => []), count: 0 };
            blocks.push({ kind: 'columns', columns: run.columns });
        }
        // One column wide is all a narrow Canvas has: a two-card widget keeps its saved width for wider ones.
        run.columns[run.count % columnCount]!.push(member.span === 2 ? { ...member, span: 1 } : member);
        run.count += 1;
    }
    return blocks;
}

/** Saved XY and flow are layout; the shared entity owner admits and commits every move. */
export const BoardCanvas = React.memo(function BoardCanvas(props: BoardCanvasProps) {
    const [width, setWidth] = React.useState(0);
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
    const rects = React.useRef(new Map<string, Rect>());
    const measured = React.useRef(new Map<string, BoardCanvasPoint>());
    const [contentHeight, setContentHeight] = React.useState(0);
    /** Each flow band's top, from the padded origin, so a card in a later band reports its true Canvas y. */
    const [blockTops, setBlockTops] = React.useState<readonly number[]>([]);
    const canvas = useBoardCanvasEntityDrop(props.binding, measured, props.snap);
    // The existing Canvas grid is the quantization boundary; Home's owner supplies demand overscan.
    const [verticalDemand] = React.useState(() => createNearViewportTracker({ quantum: gridStepPx, initialViewportHeight: 0 }));
    const [horizontalDemand] = React.useState(() => createNearViewportTracker({ quantum: gridStepPx, initialViewportHeight: 0, axis: 'x' }));
    const columnCount = resolveBoardCanvasColumnCount(Math.max(0, width - paddingPx * 2));
    const widgets = props.widgets ?? NO_WIDGETS;
    const members = React.useMemo(() => {
        const next: CanvasMember[] = [
            ...props.cards.map((card): CanvasMember => ({ kind: 'work', key: card.key, title: card.title, span: 1, card })),
            ...widgets.map((widget): CanvasMember => ({ kind: 'widget', key: widget.key, title: widget.title, span: widget.placement.width, widget })),
        ];
        if (!props.order?.length) return next;
        // The Board's manual order first (picked work and widgets, mixed); live section cards keep theirs after it.
        const rank = new Map(props.order.map((key, index) => [key, index] as const));
        return next.map((member, index) => ({ member, index }))
            .sort((a, b) => (rank.get(a.member.key) ?? props.order!.length + a.index) - (rank.get(b.member.key) ?? props.order!.length + b.index))
            .map(entry => entry.member);
    }, [props.cards, props.order, widgets]);
    const placed = members.filter(member => props.positionsByItemRef[member.key] !== undefined);
    const blocks = React.useMemo(
        () => layoutFlow(members.filter(member => props.positionsByItemRef[member.key] === undefined), columnCount),
        [columnCount, members, props.positionsByItemRef],
    );
    const reportRect = React.useCallback((key: string, rect: Rect | null) => {
        if (rect) { rects.current.set(key, rect); measured.current.set(key, { x: rect.x, y: rect.y }); }
        else { rects.current.delete(key); measured.current.delete(key); }
        let bottom = 0;
        for (const item of rects.current.values()) bottom = Math.max(bottom, item.y + item.height);
        setContentHeight(previous => previous === bottom ? previous : bottom);
    }, []);
    const onBlockLayout = React.useCallback((index: number, y: number) => {
        setBlockTops(previous => previous[index] === y ? previous : Object.assign([...previous], { [index]: y }));
    }, []);
    const placedWidth = placed.reduce((max, member) => Math.max(max, props.positionsByItemRef[member.key]!.x + memberWidthPx(member.span)), 0);
    const contentWidth = Math.max(width, placedWidth + paddingPx * 2, columnCount * (cardWidthPx + gapPx) - gapPx + paddingPx * 2);
    const cardProps = { binding: props.binding, canvas, onOpen: props.onOpen, renderWidget: props.renderWidget,
        verticalDemand, horizontalDemand, onReportRect: reportRect, onPlaced: props.onPlaced, onFocused: setFocusedKey };
    return <View style={styles.scroll}>
        <ScrollView ref={canvas.viewportRef} testID="board-canvas" style={styles.scroll} contentContainerStyle={styles.scrollContent}
            onLayout={(event: LayoutChangeEvent) => { setWidth(event.nativeEvent.layout.width); verticalDemand.onLayout(event); horizontalDemand.onLayout(event); canvas.refresh(); }}
            onScroll={event => { verticalDemand.onScroll(event); canvas.refresh(); }} scrollEventThrottle={16}>
            <ScrollView testID="board-canvas-horizontal" horizontal contentContainerStyle={{ width: contentWidth }}
                onScroll={event => { horizontalDemand.onScroll(event); canvas.refresh(); }} scrollEventThrottle={16}>
                <View ref={canvas.contentRef} collapsable={false} onLayout={canvas.refresh}
                    style={[styles.content, { width: contentWidth, minHeight: contentHeight + paddingPx * 2 }]}>
                    <View style={styles.flow}>
                        {blocks.map((block, blockIndex) => {
                            const flowY = blockTops[blockIndex] ?? 0;
                            return block.kind === 'wide'
                                ? <View key={block.member.key} onLayout={event => onBlockLayout(blockIndex, event.nativeEvent.layout.y - paddingPx)}
                                    style={{ width: memberWidthPx(2) }}>
                                    <CanvasCard {...cardProps} member={block.member} position={null} flowX={0} flowY={flowY}
                                        placing={props.placingKey === block.member.key} restoreFocus={focusedKey === block.member.key} />
                                </View>
                                : <View key={`columns:${blockIndex}`} style={styles.flowRow}
                                    onLayout={event => onBlockLayout(blockIndex, event.nativeEvent.layout.y - paddingPx)}>
                                    {block.columns.map((column, index) => <View key={index} style={styles.flowColumn}>
                                        {column.map(member => <CanvasCard key={member.key} {...cardProps} member={member} position={null}
                                            flowX={index * (cardWidthPx + gapPx)} flowY={flowY}
                                            placing={props.placingKey === member.key} restoreFocus={focusedKey === member.key} />)}
                                    </View>)}
                                </View>;
                        })}
                    </View>
                    {placed.map(member => <CanvasCard key={member.key} {...cardProps} member={member} position={props.positionsByItemRef[member.key]!}
                        flowX={0} flowY={0} placing={props.placingKey === member.key} restoreFocus={focusedKey === member.key} />)}
                </View>
            </ScrollView>
        </ScrollView>
        <CanvasMoveFeedback binding={props.binding} targetId={canvas.targetId} />
    </View>;
});

const CanvasCard = React.memo(function CanvasCard(props: Readonly<{
    member: CanvasMember; position: BoardCanvasPoint | null; flowX: number; flowY: number; placing: boolean; restoreFocus: boolean;
    binding: WorkBoardEntityBinding; canvas: ReturnType<typeof useBoardCanvasEntityDrop>;
    onOpen: (card: BoardCard) => void; onPlaced?: () => void;
    renderWidget?: BoardCanvasWidgetRender;
    verticalDemand: NearViewportTracker; horizontalDemand: NearViewportTracker;
    onReportRect: (key: string, rect: Rect | null) => void;
    onFocused: (key: string) => void;
}>) {
    const { member, binding, canvas } = props;
    // The status word follows a work card's title; a widget says what it is.
    const spoken = member.kind === 'work' ? member.card.status.word : t('boards.widgets.kind');
    const { runtime } = binding;
    const sourceId = 'work-board-card:' + React.useId();
    const pressable = React.useRef<Readonly<{ focus: () => void }> | null>(null);
    const latest = React.useRef(props); latest.current = props;
    const origin = React.useRef<BoardCanvasPoint>(props.position ?? { x: props.flowX, y: 0 });
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
    const dom = useEntityDragDomBinding({ runtime, sourceId, enabled: isHoverCapablePrimaryPointer(), describe: () => latest.current.member.title,
        canStart: (event, host) => {
            const element = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
            const control = element?.closest('button,input,textarea,a,[role="button"],[contenteditable="true"]');
            if (control && control !== host) return false;
            if (typeof window !== 'undefined' && window.getSelection()?.toString()) return false;
            canvas.setGrab(member.key, { x: event.clientX, y: event.clientY });
            return true;
        } });
    const ref = React.useCallback((node: Readonly<{ focus: () => void }> | null) => { pressable.current = node; dom(node); }, [dom]);
    React.useLayoutEffect(() => { if (props.position) origin.current = props.position; }, [props.position]);
    React.useEffect(() => { if (props.placing) pressable.current?.focus?.(); }, [props.placing]);
    // Restore the item's focus on a flow→XY remount, not when focus enters its chooser grip.
    React.useEffect(() => { if (latest.current.restoreFocus) pressable.current?.focus?.(); }, []);
    React.useEffect(() => () => { adapter.current?.cancel(); carry.current?.cancel('source-retired'); props.onReportRect(member.key, null); }, [member.key, props.onReportRect]);
    // Numeric motion updates only this carried card; the canvas never subscribes to pointer frames.
    React.useEffect(() => {
        let wasSource = false;
        return runtime.subscribe(() => {
        const snapshot = runtime.getSnapshot();
        if (snapshot.sourceId !== sourceId || snapshot.phase === 'idle' || snapshot.phase === 'settled') {
            if (!wasSource) return;
            wasSource = false;
            translateX.value = 0; translateY.value = 0; staged.current = null; return;
        }
        wasSource = true;
        if (snapshot.admission?.status !== 'allowed') { translateX.value = 0; translateY.value = 0; return; }
        const parsed = WorkBoardActionInputSchemasV1['boards.apply'].safeParse(snapshot.admission.effect.input);
        const point = parsed.success && parsed.data.intent.kind === 'set_positions' ? parsed.data.intent.positionsByItemRef[member.key] : null;
        if (point) { translateX.value = point.x - origin.current.x; translateY.value = point.y - origin.current.y; }
        });
    }, [runtime, sourceId, member.key, translateX, translateY]);
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
            announceAccessibilityMessage(t('boards.card.moved', { x: Math.round(next.x / gridStepPx), y: Math.round(next.y / gridStepPx) }));
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
    const [span, setSpan] = React.useState<NearViewportSpan | null>(null);
    const report = () => {
        const layout = ownLayout.current;
        if (!layout) return;
        const point = latest.current.position ?? { x: latest.current.flowX, y: latest.current.flowY + layout.y };
        if (member.kind === 'widget') setSpan(previous => previous?.top === paddingPx + point.y && previous.height === layout.height ? previous : { top: paddingPx + point.y, height: layout.height });
        origin.current = point; latest.current.onReportRect(member.key, { ...point, height: layout.height }); canvas.refresh();
    };
    const onLayout = (event: LayoutChangeEvent) => {
        ownLayout.current = { y: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height };
        report();
    };
    // A band above grew or shrank: the card kept its place in its band, but moved on the Canvas.
    React.useEffect(report, [props.flowY, props.position]);
    const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }] }));
    const keyboardProps = Platform.OS === 'web' ? { onKeyDown, 'aria-grabbed': state.active } : {};
    const moveActions = MOVE_ACTIONS.map(action => ({ name: action.name, label: t(`boards.card.moveActions.${action.direction}`) }));
    const onMoveAction = (event: { nativeEvent: { actionName: string } }) => {
        const action = MOVE_ACTIONS.find(candidate => candidate.name === event.nativeEvent.actionName);
        if (action) move(action.direction, false);
    };
    const grip = <DropdownMenu open={chooserOpen} onOpenChange={chooser.onOpenChange} selectedId={null} closeOnSelect={false}
        items={sections.flatMap(section => section.options.map(option => ({ id: option.id, title: option.label,
            subtitle: option.detail, disabled: option.disabled, category: section.title })))}
        onSelect={id => chooser.select(destinations[Number(id)])}
        trigger={({ toggle }) => <GestureDetector gesture={gesture}><EntityDragGripTrigger testID={'board-canvas-organize:' + member.key}
            accessibilityLabel={t('entityDragDrop.organize.grip', { item: member.title })}
            accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
            onFocusChange={focused => { setFocused(focused); if (focused) props.onFocused(member.key); }}
            // A widget's body has its own controls, so no card-wide button: its grip takes focus, the grid moves and the drag.
            {...(member.kind === 'widget' ? { controlRef: ref, accessibilityActions: moveActions, onAccessibilityAction: onMoveAction } : {})}
            onPress={toggle} onKeyDown={onKeyDown} expanded={chooserOpen} active={state.active}
                revealed={member.kind === 'widget' || !isHoverCapablePrimaryPointer() || hovered || focused || chooserOpen}
            /></GestureDetector>} />;
    const lifted = state.active || props.placing;
    const width = memberWidthPx(member.span);
    return <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onLayout={onLayout} style={props.position
        ? [styles.placed, { width, left: paddingPx + props.position.x, top: paddingPx + props.position.y }]
        : { width }}>
        <Animated.View style={[dragStyle, state.active ? styles.dragging : null]}>
            {member.kind === 'work' ? <View style={styles.cardFrame}>
                <Pressable ref={ref} testID={'board-canvas-card:' + member.key} accessibilityRole="button"
                    style={styles.cardBody} onFocus={() => { setFocused(true); props.onFocused(member.key); }} onBlur={() => setFocused(false)}
                    accessibilityLabel={member.title + ', ' + spoken} accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
                    accessibilityActions={moveActions} onAccessibilityAction={onMoveAction}
                    onPress={() => { if (!state.active) props.onOpen(member.card); }} {...keyboardProps}>
                    <BoardCardView card={member.card} lifted={lifted} />
                </Pressable>
                {grip}
            </View> : <View testID={'board-canvas-widget:' + member.key}>
                <CanvasWidgetBody widget={member.widget} span={span} left={paddingPx + (props.position?.x ?? props.flowX)} width={width}
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

const styles = StyleSheet.create(() => ({
    scroll: { flex: 1 }, scrollContent: { flexGrow: 1 }, content: { position: 'relative' },
    flow: { gap: gapPx, padding: paddingPx }, flowRow: { flexDirection: 'row', alignItems: 'flex-start', gap: gapPx },
    flowColumn: { width: cardWidthPx, gap: gapPx },
    placed: { position: 'absolute' }, dragging: { zIndex: 10 },
    cardFrame: { flexDirection: 'row', alignItems: 'center' }, cardBody: { flex: 1 },
}));
