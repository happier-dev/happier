import * as React from 'react';
import { I18nManager, Platform, View, type LayoutChangeEvent, type ScrollView } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDragKindV1, type EntityDragScopeV1, type EntityDropAdmissionV1, type EntityDropEffectV1, type EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { HAPPIER_CARRIED_SOURCE_OPACITY, describeHappierDropAnnouncement, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { t } from '@/text';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '../entityDragGestureAdapter';
import { ENTITY_DROP_UNCHANGED_CODES } from '../entityDropNoChange';
import { useEntityDragDestinations, useEntityDragDropRuntime, useEntityDragDropSnapshot, useEntityDragSource, useEntityDragSourceState, useEntityDropTarget } from '../entityDragDropHooks';
import type { EntityDragDropRuntime, EntityDragCarry } from '../entityDragDropTypes';
import { useTreeDropRegistry } from '../registry/useTreeDropRegistry';
import { measureWindowBounds, readWindowBounds } from '../registry/measureWindowBounds';
import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';
import { useTreeDropAutoscroll } from '../autoscroll/useTreeDropAutoscroll';
import { entityFlatPositionAtIndex, resolveEntityFlatRowPosition, type EntityFlatAxis } from '../geometry/entityFlatListStrategy';
import { ENTITY_STAGED_MOVE_DOCK_PLACEMENT, EntityDragGripTrigger, EntityStagedMoveDock, StagedMoveDockSlotContext, useEntityStagedMoveHints, type EntityDragGripKeyEvent } from './EntityReleasePreview';
import { EntityDropSettledFeedback } from './EntityDropSettledFeedback';
import { EntityDragGripChooser } from './EntityDragGripChooser';
import { useEntityDropOutcome } from './entityDropOutcome';
import { TreeDropIndicatorLine } from './TreeDropIndicatorLine';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { entityReorderOutcome } from '../entityReorderOutcome';

export type EntityFlatReorderBinding = Readonly<{
    scope: EntityDragScopeV1 | null;
    kind: EntityDragKindV1;
    items: readonly Readonly<{ id: string; title: string }>[];
    getItem(id: string): EntityDragItemV1 | null;
    getSourceId(item: EntityDragItemV1): string | null;
    /** Domains with layout policy project placement through their saved-layout owner. */
    projectMove?(sourceId: string, position: AnchoredListPositionV1): readonly string[] | null;
    resolve(sourceId: string, position: AnchoredListPositionV1): EntityDropAdmissionV1;
    execute(effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1>;
}>;

function entityReorderActionFailure(code?: string): EntityDropOutcomeV1 {
    const unknown = !code || code === 'outcome_unknown' || code === 'server_unreachable' || code === 'action_failed';
    return { status: unknown ? 'unknown' : 'refused', reason: {
        code: code ?? 'reorder_outcome_unknown',
        message: resolveActionExecutionFailureMessage({ ok: false, errorCode: code },
            t(unknown ? 'entityDragDrop.preview.unknownDetail' : 'entityDragDrop.reasons.generic'))!,
    } };
}

/** Checked domain save projections preserve canonical Action failure codes on rejection. */
export async function settleEntityReorderWrite(write: () => Promise<void>): Promise<EntityDropOutcomeV1> {
    try {
        await write();
        return { status: 'applied' };
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        return entityReorderActionFailure(code);
    }
}

/** Every flat-list Action joins the incumbent mounted approval and Account lifetime owner. */
export function useEntityReorderAction(scope: EntityDragScopeV1 | null) {
    const { execute } = useMountedActionExecution(scope);
    return React.useCallback((effect: EntityDropEffectV1) => executeEntityReorderAction(effect, execute), [execute]);
}

/** Only settled execution results reach the drag outcome projection. */
async function executeEntityReorderAction(effect: EntityDropEffectV1,
    execute: ReturnType<typeof useMountedActionExecution>['execute']): Promise<EntityDropOutcomeV1> {
    const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
    try {
        const actionId = ActionIdSchema.parse(effect.actionId);
        const result = await execute(actionId, effect.input);
        if (!result.ok) return entityReorderActionFailure(result.errorCode);
        const outcome = result.result;
        if (outcome && typeof outcome === 'object' && 'status' in outcome && outcome.status !== 'applied') {
            return entityReorderOutcome({ status: outcome.status === 'unknown' ? 'unknown' : 'refused',
                reason: 'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason : 'reorder_unavailable' });
        }
        return { status: 'applied' };
    } catch {
        return { status: 'unknown', reason: { code: 'reorder_outcome_unknown', message: t('entityDragDrop.preview.unknownDetail') } };
    }
}

export function entityReorderRefused(code: string): EntityDropAdmissionV1 {
    return { status: 'refused', reason: { code, message: t(ENTITY_DROP_UNCHANGED_CODES.has(code) ? 'entityDragDrop.reasons.noChange' : 'entityDragDrop.reasons.gone') } };
}

/** A place in the list's own reading direction: above/below in a column, before/after along a row (a strip). */
export function entityReorderPreview(position: AnchoredListPositionV1, items: EntityFlatReorderBinding['items'], axis: EntityFlatAxis = 'vertical'): import('@happier-dev/protocol/plugins/ui').EntityDropPreviewV1 {
    const target = items.find(item => item.id === position.anchorId)?.title ?? t('entityDragDrop.organize.title');
    const before = position.placement === 'before';
    if (axis === 'horizontal') {
        return { glyph: 'move', verb: t(before ? 'entityDragDrop.preview.moveBefore' : 'entityDragDrop.preview.moveAfter', { target }), target };
    }
    return { glyph: before ? 'above' : 'below', verb: t(before ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target }), target };
}

type FlatContext = Readonly<{
    id: string;
    runtime: EntityDragDropRuntime;
    binding: EntityFlatReorderBinding;
    organizing: boolean;
    pointerInteraction: boolean;
    axis: EntityFlatAxis;
    registry: ReturnType<typeof useTreeDropRegistry>;
    getBounds(): WindowBounds | null;
    measure(): Promise<void>;
    autoscroll(pointer: WindowPointer): void;
    /** Landing belongs to the admitted effect, not the last destination a chooser enumerated. */
    admittedMoves: WeakMap<EntityDropEffectV1, LandedMove>;
    /** The row released and waiting at its new slot for its owner's list to show the move. */
    landedItemId: string | null;
}>;
const FlatContext = React.createContext<FlatContext | null>(null);
type LandedMove = Readonly<{ itemId: string; position: AnchoredListPositionV1; order: readonly string[]; index: number }>;

function projectMove(binding: EntityFlatReorderBinding, itemId: string, position: AnchoredListPositionV1) {
    return binding.projectMove ? binding.projectMove(itemId, position)
        : resolveAnchoredListMoveV1(binding.items.map(item => item.id), itemId, position);
}

function webScrollNode(node: ScrollView | null | undefined): HTMLElement | null {
    if (Platform.OS !== 'web' || !node || typeof HTMLElement === 'undefined') return null;
    const ref = node as ScrollView & { getScrollableNode?: () => unknown };
    const candidate = ref.getScrollableNode?.() ?? node;
    return candidate instanceof HTMLElement ? candidate : null;
}

/** One thin shape consumer of the realm runtime and content registry, used by all four flat lists. */
export function EntityFlatReorderList(props: Readonly<{
    binding: EntityFlatReorderBinding;
    children: React.ReactNode;
    testID: string;
    /**
     * An editor whose whole job is arranging (a customizer, the Home layout) keeps every grip showing on touch and
     * offers no Organize toggle: its own Done closes the editor, so a second Done inside the list would duplicate it.
     */
    alwaysOrganizing?: boolean;
    /** `horizontal`: the items sit in a row (the spaces strip); places split at each item's horizontal middle. */
    axis?: EntityFlatAxis;
    scrollRef?: React.RefObject<ScrollView | null>;
    scrollOffsetY?: number | null;
    viewportHeightPx?: number | null;
    contentHeightPx?: number | null;
    scrollMetrics?: Readonly<{ offsetY: SharedValue<number>; contentHeight: SharedValue<number> }>;
    onScrollToOffset?: (y: number) => void;
}>) {
    const runtime = useEntityDragDropRuntime();
    const id = React.useId();
    const node = React.useRef<View>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const pointerY = useSharedValue<number | null>(null);
    const isActive = useSharedValue(false);
    const viewportTopY = useSharedValue(0);
    const viewportHeight = useSharedValue(0);
    const scrollOffsetY = useSharedValue(0);
    const contentHeight = useSharedValue(0);
    const viewportBounds = React.useRef<WindowBounds | null>(null);
    const registry = useTreeDropRegistry(runtime.refresh);
    const [organizing, setOrganizing] = React.useState(props.alwaysOrganizing === true);
    const inheritedScroll = usePopoverScrollSourceRef();
    const scrollRef = props.scrollRef ?? inheritedScroll;
    const latest = React.useRef(props);
    latest.current = props;
    const measure = React.useCallback(async () => {
        nativeBounds.current = await measureWindowBounds(node.current);
        const scroll = scrollRef?.current;
        const dom = webScrollNode(scroll);
        const viewport = await measureWindowBounds(dom ?? scroll ?? null);
        if (viewport) { viewportBounds.current = viewport; viewportTopY.value = viewport.y; viewportHeight.value = viewport.height; }
        if (typeof dom?.scrollTop === 'number') scrollOffsetY.value = dom.scrollTop;
        else if (latest.current.scrollMetrics) scrollOffsetY.value = latest.current.scrollMetrics.offsetY.value;
        else if (typeof latest.current.scrollOffsetY === 'number') scrollOffsetY.value = latest.current.scrollOffsetY;
        if (typeof dom?.scrollHeight === 'number') contentHeight.value = dom.scrollHeight;
        else if (latest.current.scrollMetrics) contentHeight.value = latest.current.scrollMetrics.contentHeight.value;
        else if (typeof latest.current.contentHeightPx === 'number') contentHeight.value = latest.current.contentHeightPx;
        runtime.refresh();
    }, [runtime, scrollRef, viewportTopY, viewportHeight, scrollOffsetY, contentHeight]);
    const getBounds = React.useCallback(() => readWindowBounds(node.current) ?? nativeBounds.current, []);
    React.useEffect(() => { void measure(); }, [measure, props.scrollOffsetY, props.viewportHeightPx, props.contentHeightPx]);
    const scrollMetrics = props.scrollMetrics;
    useAnimatedReaction(() => scrollMetrics ? [scrollMetrics.offsetY.value, scrollMetrics.contentHeight.value] : null,
        (metrics, previous) => { if (metrics && (metrics[0] !== previous?.[0] || metrics[1] !== previous?.[1])) scheduleOnRN(measure); }, [measure, scrollMetrics]);
    const autoscroll = React.useCallback((pointer: WindowPointer) => {
        pointerY.value = pointer.y;
    }, [pointerY]);
    const scrollToOffset = React.useCallback((next: number) => {
        const scroll = scrollRef?.current;
        const dom = webScrollNode(scroll);
        if (latest.current.onScrollToOffset) latest.current.onScrollToOffset(next);
        else if (dom) dom.scrollTop = next;
        else scroll?.scrollTo({ y: next, animated: false });
        void measure();
    }, [measure, scrollRef]);
    useTreeDropAutoscroll({ isActive, pointerY, viewportTopY, viewportHeight, scrollOffsetY, contentHeight, scrollToOffset });
    React.useEffect(() => {
        // An admitted place in this list engages the edge zones. They stay engaged over the scroller's own trailing
        // space (padding, a row after the list, a header), which is no drop place, until the carry ends, leaves the
        // viewport, or lands on another list's place or one this list refuses.
        let engaged = false;
        const update = () => {
            const snapshot = runtime.getSnapshot();
            const inList = snapshot.targetId !== null
                && latest.current.binding.items.some(item => rowTargetId({ id }, item.id) === snapshot.targetId);
            if (snapshot.phase !== 'carrying') engaged = false;
            else if (inList) engaged = snapshot.admission?.status === 'allowed';
            else if (snapshot.targetId !== null) engaged = false;
            const pointer = runtime.getPointer();
            const viewport = viewportBounds.current;
            const inTrailingSpace = engaged && !inList && pointer !== null && viewport !== null
                && pointer.x >= viewport.x && pointer.x <= viewport.x + viewport.width
                && pointer.y >= viewport.y && pointer.y <= viewport.y + viewport.height;
            isActive.value = engaged && (inList || inTrailingSpace);
            // A selected place's runtime callback supplies the pointer; only trailing space reads it directly.
            if (!isActive.value) pointerY.value = null;
            else if (inTrailingSpace) pointerY.value = pointer.y;
        };
        update();
        const semantic = runtime.subscribe(update);
        const frames = runtime.subscribePointer(update);
        return () => { semantic(); frames(); isActive.value = false; pointerY.value = null; };
    }, [runtime, id, isActive, pointerY]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const refresh = () => { void measure(); };
        window.addEventListener('scroll', refresh, true);
        window.addEventListener('resize', refresh);
        return () => { window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); };
    }, [measure]);
    const pointerInteraction = useHoverCapablePrimaryPointer();
    const [admittedMoves] = React.useState(() => new WeakMap<EntityDropEffectV1, LandedMove>());
    const dispatchedEffect = React.useRef<EntityDropEffectV1 | null>(null);
    // A released row waits where it was dropped until its owner's list shows the move (or the move is refused).
    // That projection can arrive before or after the drag runtime settles.
    const orderKey = props.binding.items.map(item => item.id).join('\u0000');
    const [landed, setLanded] = React.useState<LandedMove | null>(null);
    React.useEffect(() => runtime.subscribe(() => {
        const snapshot = runtime.getSnapshot();
        if (snapshot.phase === 'pending' && snapshot.admission?.status === 'allowed') {
            const effect = snapshot.admission.effect;
            if (dispatchedEffect.current === effect) return;
            dispatchedEffect.current = effect;
            setLanded(admittedMoves.get(effect) ?? null);
        } else if (snapshot.phase === 'carrying' || snapshot.item === null
            || (snapshot.phase === 'settled' && snapshot.outcome?.status !== 'applied')) {
            if (snapshot.phase === 'carrying') dispatchedEffect.current = null;
            setLanded(null);
        }
    }), [runtime, admittedMoves]);
    React.useEffect(() => {
        if (!landed) return;
        const acknowledged = projectMove(props.binding, landed.itemId, landed.position);
        if (!acknowledged || acknowledged.join('\u0000') === orderKey) setLanded(null);
    }, [landed, orderKey, props.binding]);
    const landedItemId = landed?.itemId ?? null;
    const axis = props.axis ?? 'vertical';
    const context = React.useMemo(() => ({ id, runtime, binding: props.binding, organizing, pointerInteraction, axis, registry, getBounds, measure, autoscroll, admittedMoves, landedItemId }), [id, runtime, props.binding, organizing, pointerInteraction, axis, registry, getBounds, measure, autoscroll, admittedMoves, landedItemId]);
    const children = React.useMemo(
        () => projectFlatChildren(props.children, props.binding.items.map(item => item.id), landed),
        [props.children, props.binding.items, landed],
    );
    // Organize is for coarse pointers only, and only when there is something to organize: hover-capable
    // pointers already have the grip on every row (lab K1h; a control with an empty target set is hidden).
    const canOrganize = props.alwaysOrganizing !== true && !pointerInteraction && props.binding.scope !== null && props.binding.items.length > 1;
    return <FlatContext.Provider value={context}>
        <View ref={node} testID={props.testID} style={axis === 'horizontal' ? HORIZONTAL_LIST_STYLE : undefined} onLayout={() => { void measure(); }}>
            {children}
            <FlatFeedback context={context} testID={props.testID} />
        </View>
        {canOrganize ? <RoundButton testID={`${props.testID}.organize`} size="small" display="secondary"
            title={t(organizing ? 'entityDragDrop.organize.done' : 'entityDragDrop.organize.enter')}
            onPress={() => { if (props.binding.items.some(item => rowSourceId(context, item.id) === runtime.getSnapshot().sourceId)) runtime.cancel('organize-exit'); setOrganizing(value => !value); }} /> : null}
    </FlatContext.Provider>;
}

/**
 * The list's rows, in the order a landed move will leave them (rows are keyed by their item id). The rows always go
 * through the same key normalisation, so a row keeps its identity whether or not a move is waiting; the order is
 * left alone when any row is not keyed by an item id.
 */
function projectFlatChildren(children: React.ReactNode, ids: readonly string[], landed: LandedMove | null): React.ReactNode {
    const rows = React.Children.toArray(children);
    if (!landed) return rows;
    const next = landed.order;
    const keyOf = (row: React.ReactNode) => React.isValidElement(row) && typeof row.key === 'string' ? row.key.slice(row.key.lastIndexOf('$') + 1) : null;
    if (ids.some(id => !next.includes(id)) || rows.some(row => keyOf(row) === null || !ids.includes(keyOf(row)!))) return rows;
    return [...rows].sort((a, b) => next.indexOf(keyOf(a)!) - next.indexOf(keyOf(b)!));
}

function rowTargetId(context: Pick<FlatContext, 'id'>, id: string): string { return JSON.stringify([context.id, 'target', id]); }
function rowSourceId(context: Pick<FlatContext, 'id'>, id: string): string { return JSON.stringify([context.id, 'source', id]); }

/** Optional handle slot keeps dense domain rows in their existing layout and normal flow. */
export function EntityFlatReorderRow(props: Readonly<{
    id: string;
    /** Retain the mounted row while its domain temporarily disallows individual reordering. */
    reorderable?: boolean;
    /** The row's owner has a write for this row in flight: it waits half-dimmed, as a released move does. */
    pending?: boolean;
    children: React.ReactNode | ((args: Readonly<{ renderHandle: (testID?: string) => React.ReactNode; isDragging: boolean; moveBy: (delta: number) => Promise<EntityDropOutcomeV1 | null> }>) => React.ReactNode);
}>) {
    const context = React.useContext(FlatContext);
    if (!context) throw new Error('EntityFlatReorderRow requires its list owner');
    return context.binding.scope ? <MountedFlatRow {...props} context={context} scope={context.binding.scope} />
        : <View>{typeof props.children === 'function' ? props.children({ renderHandle: () => null, isDragging: false, moveBy: async () => null }) : props.children}</View>;
}

function MountedFlatRow(props: React.ComponentProps<typeof EntityFlatReorderRow> & Readonly<{ context: FlatContext; scope: EntityDragScopeV1 }>) {
    const { context, id, scope } = props;
    const reorderable = props.reorderable !== false;
    const { runtime, registry } = context;
    const latest = React.useRef(context);
    latest.current = context;
    const sourceId = rowSourceId(context, id);
    const targetId = rowTargetId(context, id);
    const active = useEntityDragSourceState(runtime, sourceId);
    // Released and waiting: at its new slot and half-dimmed until the owner's list shows it.
    const waiting = context.landedItemId === id || props.pending === true;
    const settledMatch = React.useMemo(() => ({ sourceId }), [sourceId]);
    const [chooserOpen, setChooserOpen] = React.useState(false);
    React.useEffect(() => { if (!reorderable) setChooserOpen(false); }, [reorderable]);
    const rowNode = React.useRef<View>(null);
    const current = () => {
        const ownerScope = latest.current.binding.scope;
        return reorderable && ownerScope !== null && entityDragScopesEqualV1(ownerScope, scope) && latest.current.binding.items.some(item => item.id === id);
    };
    useEntityDragSource(runtime, { id: sourceId, scope, isCurrent: current,
        getItem: () => latest.current.binding.getItem(id), getBounds: () => getBounds(),
        describe: () => ({ title: latest.current.binding.items.find(item => item.id === id)?.title ?? '', announcementOwner: 'source' }) }, reorderable);
    const getBounds = () => {
        const live = readWindowBounds(rowNode.current);
        if (live) return live;
        const list = latest.current.getBounds();
        const row = registry.getContentGeometry().rows.find(row => row.id === id);
        return list && row ? { x: list.x + row.bounds.x, y: list.y + row.bounds.y, width: row.bounds.width, height: row.bounds.height } : null;
    };
    // The foreground list owns its row kind even where a smaller page target lies behind it.
    useEntityDropTarget(runtime, { id: targetId, scope, acceptedKinds: [context.binding.kind], captureKinds: [context.binding.kind], isCurrent: current, getBounds,
        // Each place is listed once: a gap between two rows is "before" the lower one; only the end is "after" a row.
        listDestinations: () => (latest.current.binding.items.at(-1)?.id === id ? ['before', 'after'] as const : ['before'] as const).map(placement => {
            const position = { anchorId: id, placement };
            return { destination: position, label: entityReorderPreview(position, latest.current.binding.items, latest.current.axis).verb };
        }),
        resolve: ({ item, pointer, destination }) => {
            const source = latest.current.binding.getSourceId(item);
            if (!source || !entityDragScopesEqualV1(item.scope, scope)) return entityReorderRefused('reorder_scope_mismatch');
            const bounds = getBounds();
            const parsed = AnchoredListPositionV1Schema.safeParse(destination);
            const position = pointer && bounds ? resolveEntityFlatRowPosition(id, bounds, pointer, latest.current.axis, I18nManager.isRTL) : parsed.success ? parsed.data : null;
            if (!position) return entityReorderRefused('reorder_target_gone');
            const admission = latest.current.binding.resolve(source, position);
            if (admission.status === 'allowed') {
                const order = projectMove(latest.current.binding, source, position);
                if (order) latest.current.admittedMoves.set(admission.effect, { itemId: source, position, order, index: order.indexOf(source) });
            }
            return admission;
        },
        getDestinationKey: (_context, admission) => {
            const move = latest.current.admittedMoves.get(admission.effect);
            // Two neighboring row edges can describe the same resulting gap.
            return move ? JSON.stringify([context.id, move.index]) : null;
        },
        execute: effect => latest.current.binding.execute(effect), autoscroll: context.autoscroll });
    React.useEffect(() => () => registry.unregisterRow(id), [registry, id]);
    const adapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const endStarted = React.useRef(false);
    const allowBody = React.useRef(true);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        // RN Web does not forward pointer capture props. Listen on the actual View ref
        // before the gesture handler sees the event; never intercept row activation.
        const node = rowNode.current as (View & HTMLElement) | null;
        if (!node?.addEventListener) return;
        const capture = (event: PointerEvent) => {
            const element = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
            const control = element?.closest('button,input,textarea,a,[role="button"],[role="switch"],[role="radio"],[contenteditable="true"]');
            allowBody.current = event.pointerType !== 'touch'
                && (!control || control.getAttribute('data-entity-drag-body') === 'true')
                && !(typeof window !== 'undefined' && window.getSelection()?.toString());
        };
        node.addEventListener('pointerdown', capture, true);
        return () => node.removeEventListener('pointerdown', capture, true);
    }, []);
    const createGesture = React.useCallback((body: boolean) => Gesture.Pan().enabled(reorderable).minDistance(ENTITY_DRAG_ACTIVATION_DISTANCE_PX).runOnJS(true)
        .onTouchesDown((_event, manager) => { if (body && !allowBody.current) manager.fail(); })
        .onStart(event => {
            endStarted.current = false;
            const carry = runtime.begin(sourceId, 'pointer');
            adapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            if (carry) {
                setChooserOpen(false);
                void latest.current.measure().then(() => carry.move({ x: event.absoluteX, y: event.absoluteY }));
            }
        })
        .onUpdate(event => {
            const activeAdapter = adapter.current;
            if (!activeAdapter) return;
            void latest.current.measure().then(() => { activeAdapter.update({ x: event.absoluteX, y: event.absoluteY }); runtime.autoscroll(); });
        })
        .onEnd((event, success) => {
            endStarted.current = true;
            const activeAdapter = adapter.current;
            if (!activeAdapter) return;
            if (!success) { void activeAdapter.end(false); return; }
            void latest.current.measure().then(() => activeAdapter.end(true, { x: event.absoluteX, y: event.absoluteY }));
        })
        .onFinalize(() => { if (!endStarted.current) adapter.current?.finalize(); }), [runtime, sourceId, reorderable]);
    const gesture = React.useMemo(() => createGesture(true), [createGesture]);
    const handleGesture = React.useMemo(() => createGesture(false), [createGesture]);
    React.useEffect(() => () => adapter.current?.cancel(), []);
    const keyboardCarry = React.useRef<EntityDragCarry | null>(null);
    const staged = React.useRef<AnchoredListPositionV1 | null>(null);
    const onKeyDown = (event: EntityDragGripKeyEvent): boolean => {
        if (!reorderable) return false;
        const picked = runtime.getSnapshot().phase === 'carrying' && runtime.getSnapshot().sourceId === sourceId;
        const intent = resolveHappierStagedMoveKey({ key: event.key, repeat: event.repeat, staged: picked, rtl: I18nManager.isRTL });
        if (!intent) return false;
        event.preventDefault(); event.stopPropagation();
        if (intent === 'pickUp') {
            keyboardCarry.current = runtime.begin(sourceId, 'keyboard');
            staged.current = { anchorId: id, placement: 'before' };
            keyboardCarry.current?.choose(targetId, staged.current);
        } else if (intent === 'cancel') {
            keyboardCarry.current?.cancel('keyboard-escape'); keyboardCarry.current = null;
        } else if (intent === 'drop') {
            void keyboardCarry.current?.release(); keyboardCarry.current = null;
        } else if (intent === 'previous' || intent === 'next') {
            const ids = latest.current.binding.items.map(item => item.id);
            const projected = staged.current ? projectMove(latest.current.binding, id, staged.current) : ids;
            const position = entityFlatPositionAtIndex(ids, id, (projected ?? ids).indexOf(id) + (intent === 'previous' ? -1 : 1));
            if (!position) return true;
            staged.current = position;
            keyboardCarry.current?.choose(rowTargetId(context, position.anchorId ?? id), position);
        }
        return true;
    };
    const destinations = useEntityDragDestinations(runtime, sourceId, chooserOpen && reorderable).filter(destination => context.binding.items.some(item => rowTargetId(context, item.id) === destination.targetId));
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? t('entityDragDrop.organize.title'),
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    const handle = (testID?: string) => <EntityDragGripChooser open={chooserOpen} onOpenChange={setChooserOpen} sections={sections}
        onSelect={key => { const destination = destinations[Number(key)]; if (destination) void runtime.perform(sourceId, destination.targetId, destination.destination, 'chooser'); }}
        trigger={({ toggle }) => <GestureDetector gesture={handleGesture}><EntityDragGripTrigger testID={testID}
            accessibilityLabel={t('entityDragDrop.organize.grip', { item: context.binding.items.find(item => item.id === id)?.title ?? '' })}
            accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
            onPress={() => {
                // A release can also reach the press boundary. The drag owner's
                // carry/acknowledgement still owns that interaction until settled.
                const phase = runtime.getSnapshot().phase;
                if (phase !== 'carrying' && phase !== 'pending') toggle();
            }} onKeyDown={onKeyDown} expanded={chooserOpen}
            active={active.phase === 'carrying' || waiting} density={context.pointerInteraction ? 'pointer' : 'touch'} /></GestureDetector>} />;
    const moveBy = (delta: number) => {
        if (!reorderable) return Promise.resolve(null);
        const ids = latest.current.binding.items.map(item => item.id);
        const position = entityFlatPositionAtIndex(ids, id, ids.indexOf(id) + delta);
        return position ? runtime.perform(sourceId, rowTargetId(context, position.anchorId ?? id), position, 'chooser') : Promise.resolve(null);
    };
    const showHandle = reorderable && (context.organizing || context.pointerInteraction);
    const contents = typeof props.children === 'function' ? props.children({ renderHandle: showHandle ? handle : () => null, isDragging: reorderable && active.phase === 'carrying', moveBy })
        : <View style={{ flexDirection: 'row', alignItems: 'center' }}>{showHandle ? handle() : null}<View style={{ flex: 1 }}>{props.children}</View></View>;
    const body = <View ref={rowNode} onLayout={(event: LayoutChangeEvent) => {
        registry.registerRow({ id, containerId: context.id, parentId: null, depth: 0, kind: 'leaf', bounds: event.nativeEvent.layout });
        void latest.current.measure().then(async () => {
            const row = await measureWindowBounds(rowNode.current);
            const list = latest.current.getBounds();
            if (row && list) registry.registerRow({ id, containerId: context.id, parentId: null, depth: 0, kind: 'leaf', bounds: { x: row.x - list.x, y: row.y - list.y, width: row.width, height: row.height } });
        });
    }} style={{ opacity: waiting ? PENDING_SOURCE_OPACITY : active.phase === 'carrying' ? HAPPIER_CARRIED_SOURCE_OPACITY : 1 }}>
        {contents}<FlatRowIndicator runtime={runtime} targetId={targetId} admittedMoves={context.admittedMoves} axis={context.axis} />
    </View>;
    // Lab ST4: a move its owner refused late stays under this row in words.
    return <EntityDropSettledFeedback runtime={runtime} match={settledMatch}>
        {context.pointerInteraction ? <GestureDetector gesture={gesture}>{body}</GestureDetector> : body}
    </EntityDropSettledFeedback>;
}

const HORIZONTAL_LIST_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;

/** A write on its way: the row sits at its new place, half-dimmed (a carried source is dimmer). */
const PENDING_SOURCE_OPACITY = 1 - (1 - HAPPIER_CARRIED_SOURCE_OPACITY) / 2;

function FlatRowIndicator(props: Readonly<{ runtime: EntityDragDropRuntime; targetId: string; admittedMoves: FlatContext['admittedMoves']; axis: EntityFlatAxis }>) {
    const edge = React.useSyncExternalStore(props.runtime.subscribe, () => {
        const snapshot = props.runtime.getSnapshot();
        // The insertion line belongs to the carry; once released the row itself shows where it landed.
        if (snapshot.phase !== 'carrying') return null;
        if (snapshot.targetId !== props.targetId || snapshot.admission?.status !== 'allowed') return null;
        // A drag and a keyboard carry draw the one line at the staged place. Semantic admission changes only; this
        // leaf never subscribes to pointer frames.
        return props.admittedMoves.get(snapshot.admission.effect)?.position.placement ?? null;
    }, () => null);
    if (!edge) return null;
    const visual = { kind: 'line', targetId: props.targetId, depth: 0, edge: edge === 'before' ? 'top' : 'bottom' } as const;
    // Between tabs in a row the mark stands upright at the leading or trailing edge (start/end follow RTL).
    return props.axis === 'horizontal'
        ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, ...(edge === 'before' ? { start: 0 } : { end: 0 }) }}><TreeDropIndicatorLine visual={visual} indentPx={0} orientation="vertical" /></View>
        : <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, ...(edge === 'before' ? { top: 0 } : { bottom: 0 }) }}><TreeDropIndicatorLine visual={visual} indentPx={0} /></View>;
}

/**
 * The staged keyboard preview, docked over the list's foot so the list never grows when a move starts. It
 * belongs to the carry: once the move is released (a chooser commit or a keyboard drop) the row itself waits
 * half-dimmed at its landing slot and the live region says so, so no key-hint card is drawn over its neighbours.
 */
function FlatFeedback(props: Readonly<{ context: FlatContext; testID: string }>) {
    const snapshot = useEntityDragDropSnapshot(props.context.runtime);
    const hints = useEntityStagedMoveHints();
    const ours = props.context.binding.items.some(item => rowSourceId(props.context, item.id) === snapshot.sourceId);
    const staged = ours && (snapshot.phase === 'carrying' || snapshot.phase === 'pending' && props.context.landedItemId !== null);
    const outcome = useEntityDropOutcome(staged ? snapshot : null);
    const keyboard = props.context.runtime.getPointer() === null;
    const docked = outcome !== null && keyboard && snapshot.phase === 'carrying';
    // A host footer (the Sections popover) takes the dock; without one it sits over the list's foot.
    const slot = React.useContext(StagedMoveDockSlotContext);
    const outcomeKey = JSON.stringify(outcome);
    React.useEffect(() => {
        if (!slot || !docked || !outcome) return;
        slot(<EntityStagedMoveDock testID={`${props.testID}.staged`} outcome={outcome} hints={hints} />);
        return () => slot(null);
        // `outcome` is rebuilt on every render; its content is the dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slot, docked, outcomeKey, hints, props.testID]);
    return <>
        {docked && !slot ? <View pointerEvents="none" style={ENTITY_STAGED_MOVE_DOCK_PLACEMENT}>
            <EntityStagedMoveDock testID={`${props.testID}.staged`} outcome={outcome} hints={hints} />
        </View> : null}
        <PoliteAccessibilityStatus statusTestID={`${props.testID}.status`} transitionKey={JSON.stringify([snapshot.phase, snapshot.targetId, outcome])} announcement={describeHappierDropAnnouncement(outcome)} />
    </>;
}
