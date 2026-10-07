import * as React from 'react';
import { I18nManager, Platform, View, type LayoutChangeEvent, type ScrollView } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDragKindV1, type EntityDragScopeV1, type EntityDropAdmissionV1, type EntityDropEffectV1, type EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { HAPPIER_CARRIED_SOURCE_OPACITY, describeHappierDropAnnouncement, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { t } from '@/text';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '../entityDragGestureAdapter';
import { useEntityDragDestinations, useEntityDragDropRuntime, useEntityDragDropSnapshot, useEntityDragSource, useEntityDragSourceState, useEntityDropTarget } from '../entityDragDropHooks';
import type { EntityDragDropRuntime, EntityDragCarry } from '../entityDragDropTypes';
import { useTreeDropRegistry } from '../registry/useTreeDropRegistry';
import { measureWindowBounds, readWindowBounds } from '../registry/measureWindowBounds';
import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';
import { useTreeDropAutoscroll } from '../autoscroll/useTreeDropAutoscroll';
import { entityFlatPositionAtIndex, resolveEntityFlatRowPosition } from '../geometry/entityFlatListStrategy';
import { ENTITY_STAGED_MOVE_DOCK_PLACEMENT, EntityDragGripTrigger, EntityStagedMoveDock, useEntityStagedMoveHints, type EntityDragGripKeyEvent } from './EntityReleasePreview';
import { EntityDropSettledFeedback } from './EntityDropSettledFeedback';
import { describeEntityDropOutcome } from './entityDropOutcome';
import { TreeDropIndicatorLine } from './TreeDropIndicatorLine';

export type EntityFlatReorderBinding = Readonly<{
    scope: EntityDragScopeV1 | null;
    kind: EntityDragKindV1;
    items: readonly Readonly<{ id: string; title: string }>[];
    getItem(id: string): EntityDragItemV1 | null;
    getSourceId(item: EntityDragItemV1): string | null;
    resolve(sourceId: string, position: AnchoredListPositionV1): EntityDropAdmissionV1;
    execute(effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1>;
}>;

function entityReorderActionFailure(code?: string): EntityDropOutcomeV1 {
    const unknown = !code || code === 'outcome_unknown' || code === 'server_unreachable' || code === 'action_failed';
    return { status: unknown ? 'unknown' : 'refused', reason: {
        code: code ?? 'reorder_outcome_unknown',
        message: t(unknown ? 'entityDragDrop.preview.unknownDetail' : 'entityDragDrop.reasons.generic'),
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

/** Present-user execution preserves the existing Action policy and the exact Account fence. */
export async function executeEntityReorderAction(effect: EntityDropEffectV1, scope: EntityDragScopeV1): Promise<EntityDropOutcomeV1> {
    const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
    try {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const actionId = ActionIdSchema.parse(effect.actionId);
        const result = await createDefaultActionExecutor().execute(actionId, effect.input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
        });
        if (!result.ok) return entityReorderActionFailure(result.errorCode);
        const outcome = result.result;
        if (outcome && typeof outcome === 'object' && 'status' in outcome && outcome.status !== 'applied') {
            const status = outcome.status === 'unknown' ? 'unknown' : 'refused';
            return { status, reason: { code: 'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason : 'reorder_unavailable', message: t('entityDragDrop.reasons.gone') } };
        }
        return { status: 'applied' };
    } catch {
        return { status: 'unknown', reason: { code: 'reorder_outcome_unknown', message: t('entityDragDrop.preview.unknownDetail') } };
    }
}

export function entityReorderRefused(code: string): EntityDropAdmissionV1 {
    return { status: 'refused', reason: { code, message: t(code === 'same-position' ? 'entityDragDrop.reasons.noChange' : 'entityDragDrop.reasons.gone') } };
}

export function entityReorderPreview(position: AnchoredListPositionV1, items: EntityFlatReorderBinding['items']): import('@happier-dev/protocol/plugins/ui').EntityDropPreviewV1 {
    const target = items.find(item => item.id === position.anchorId)?.title ?? t('entityDragDrop.organize.title');
    return { glyph: position.placement === 'before' ? 'above' : 'below', verb: t(position.placement === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target }), target };
}

type FlatContext = Readonly<{
    id: string;
    runtime: EntityDragDropRuntime;
    binding: EntityFlatReorderBinding;
    organizing: boolean;
    pointerInteraction: boolean;
    registry: ReturnType<typeof useTreeDropRegistry>;
    getBounds(): WindowBounds | null;
    measure(): Promise<void>;
    autoscroll(pointer: WindowPointer): void;
}>;
const FlatContext = React.createContext<FlatContext | null>(null);

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
    initialOrganizing?: boolean;
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
    const registry = useTreeDropRegistry(runtime.refresh);
    const [organizing, setOrganizing] = React.useState(props.initialOrganizing === true);
    const inheritedScroll = usePopoverScrollSourceRef();
    const scrollRef = props.scrollRef ?? inheritedScroll;
    const latest = React.useRef(props);
    latest.current = props;
    const measure = React.useCallback(async () => {
        nativeBounds.current = await measureWindowBounds(node.current);
        const scroll = scrollRef?.current;
        const dom = webScrollNode(scroll);
        const viewport = await measureWindowBounds(dom ?? scroll ?? null);
        if (viewport) { viewportTopY.value = viewport.y; viewportHeight.value = viewport.height; }
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
    useAnimatedReaction(() => props.scrollMetrics ? [props.scrollMetrics.offsetY.value, props.scrollMetrics.contentHeight.value] : null,
        (metrics, previous) => { if (metrics && (metrics[0] !== previous?.[0] || metrics[1] !== previous?.[1])) scheduleOnRN(measure); }, [measure, props.scrollMetrics]);
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
        const update = () => {
            const snapshot = runtime.getSnapshot();
            isActive.value = snapshot.phase === 'carrying' && props.binding.items.some(item => rowSourceId({ id }, item.id) === snapshot.sourceId);
            pointerY.value = isActive.value ? runtime.getPointer()?.y ?? null : null;
        };
        update();
        const semantic = runtime.subscribe(update);
        const pointer = runtime.subscribePointer(update);
        return () => { semantic(); pointer(); isActive.value = false; pointerY.value = null; };
    }, [runtime, id, props.binding.items, isActive, pointerY]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const refresh = () => { void measure(); };
        window.addEventListener('scroll', refresh, true);
        window.addEventListener('resize', refresh);
        return () => { window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); };
    }, [measure]);
    const pointerInteraction = isHoverCapablePrimaryPointer();
    const context = React.useMemo(() => ({ id, runtime, binding: props.binding, organizing, pointerInteraction, registry, getBounds, measure, autoscroll }), [id, runtime, props.binding, organizing, pointerInteraction, registry, getBounds, measure, autoscroll]);
    // Organize is for coarse pointers only, and only when there is something to organize: hover-capable
    // pointers already have the grip on every row (lab K1h; a control with an empty target set is hidden).
    const canOrganize = !pointerInteraction && props.binding.scope !== null && props.binding.items.length > 1;
    return <FlatContext.Provider value={context}>
        <View ref={node} testID={props.testID} onLayout={() => { void measure(); }}>
            {props.children}
            <FlatFeedback context={context} testID={props.testID} />
        </View>
        {canOrganize ? <RoundButton testID={`${props.testID}.organize`} size="small" display="secondary"
            title={t(organizing ? 'entityDragDrop.organize.done' : 'entityDragDrop.organize.enter')}
            onPress={() => { if (props.binding.items.some(item => rowSourceId(context, item.id) === runtime.getSnapshot().sourceId)) runtime.cancel('organize-exit'); setOrganizing(value => !value); }} /> : null}
    </FlatContext.Provider>;
}

function rowTargetId(context: Pick<FlatContext, 'id'>, id: string): string { return JSON.stringify([context.id, 'target', id]); }
function rowSourceId(context: Pick<FlatContext, 'id'>, id: string): string { return JSON.stringify([context.id, 'source', id]); }

/** Optional handle slot keeps dense domain rows in their existing layout and normal flow. */
export function EntityFlatReorderRow(props: Readonly<{
    id: string;
    children: React.ReactNode | ((args: Readonly<{ renderHandle: (testID?: string) => React.ReactNode; isDragging: boolean; moveBy: (delta: number) => Promise<EntityDropOutcomeV1 | null> }>) => React.ReactNode);
}>) {
    const context = React.useContext(FlatContext);
    if (!context) throw new Error('EntityFlatReorderRow requires its list owner');
    return context.binding.scope ? <MountedFlatRow {...props} context={context} scope={context.binding.scope} />
        : <View>{typeof props.children === 'function' ? props.children({ renderHandle: () => null, isDragging: false, moveBy: async () => null }) : props.children}</View>;
}

function MountedFlatRow(props: React.ComponentProps<typeof EntityFlatReorderRow> & Readonly<{ context: FlatContext; scope: EntityDragScopeV1 }>) {
    const { context, id, scope } = props;
    const { runtime, registry } = context;
    const latest = React.useRef(context);
    latest.current = context;
    const sourceId = rowSourceId(context, id);
    const targetId = rowTargetId(context, id);
    const active = useEntityDragSourceState(runtime, sourceId);
    const settledMatch = React.useMemo(() => ({ sourceId }), [sourceId]);
    const [chooserOpen, setChooserOpen] = React.useState(false);
    const rowNode = React.useRef<View>(null);
    const resolvedPosition = React.useRef<AnchoredListPositionV1 | null>(null);
    const current = () => {
        const ownerScope = latest.current.binding.scope;
        return ownerScope !== null && entityDragScopesEqualV1(ownerScope, scope) && latest.current.binding.items.some(item => item.id === id);
    };
    useEntityDragSource(runtime, { id: sourceId, scope, isCurrent: current,
        getItem: () => latest.current.binding.getItem(id), describe: () => ({ title: latest.current.binding.items.find(item => item.id === id)?.title ?? '' }) });
    const getBounds = () => {
        const live = readWindowBounds(rowNode.current);
        if (live) return live;
        const list = latest.current.getBounds();
        const row = registry.getContentGeometry().rows.find(row => row.id === id);
        return list && row ? { x: list.x + row.bounds.x, y: list.y + row.bounds.y, width: row.bounds.width, height: row.bounds.height } : null;
    };
    useEntityDropTarget(runtime, { id: targetId, scope, acceptedKinds: [context.binding.kind], isCurrent: current, getBounds,
        listDestinations: () => (['before', 'after'] as const).map(placement => {
            const position = { anchorId: id, placement };
            return { destination: position, label: entityReorderPreview(position, latest.current.binding.items).verb };
        }),
        resolve: ({ item, pointer, destination }) => {
            const source = latest.current.binding.getSourceId(item);
            if (!source || !entityDragScopesEqualV1(item.scope, scope)) return entityReorderRefused('reorder_scope_mismatch');
            const bounds = getBounds();
            const parsed = AnchoredListPositionV1Schema.safeParse(destination);
            const position = pointer && bounds ? resolveEntityFlatRowPosition(id, bounds, pointer) : parsed.success ? parsed.data : null;
            resolvedPosition.current = position;
            return position ? latest.current.binding.resolve(source, position) : entityReorderRefused('reorder_target_gone');
        }, execute: effect => latest.current.binding.execute(effect), autoscroll: context.autoscroll });
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
    const createGesture = React.useCallback((body: boolean) => Gesture.Pan().minDistance(ENTITY_DRAG_ACTIVATION_DISTANCE_PX).runOnJS(true)
        .onTouchesDown((_event, manager) => { if (body && !allowBody.current) manager.fail(); })
        .onStart(event => {
            endStarted.current = false;
            const carry = runtime.begin(sourceId, 'pointer');
            adapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            if (carry) void latest.current.measure().then(() => carry.move({ x: event.absoluteX, y: event.absoluteY }));
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
        .onFinalize(() => { if (!endStarted.current) adapter.current?.finalize(); }), [runtime, sourceId]);
    const gesture = React.useMemo(() => createGesture(true), [createGesture]);
    const handleGesture = React.useMemo(() => createGesture(false), [createGesture]);
    React.useEffect(() => () => adapter.current?.cancel(), []);
    const keyboardCarry = React.useRef<EntityDragCarry | null>(null);
    const staged = React.useRef<AnchoredListPositionV1 | null>(null);
    const onKeyDown = (event: EntityDragGripKeyEvent): boolean => {
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
            const projected = staged.current ? resolveAnchoredListMoveV1(ids, id, staged.current) : ids;
            const position = entityFlatPositionAtIndex(ids, id, (projected ?? ids).indexOf(id) + (intent === 'previous' ? -1 : 1));
            if (!position) return true;
            staged.current = position;
            keyboardCarry.current?.choose(rowTargetId(context, position.anchorId ?? id), position);
        }
        return true;
    };
    const destinations = useEntityDragDestinations(runtime, sourceId, chooserOpen).filter(destination => context.binding.items.some(item => rowTargetId(context, item.id) === destination.targetId));
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? t('entityDragDrop.organize.title'),
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    const handle = (testID?: string) => <DropdownMenu open={chooserOpen} onOpenChange={setChooserOpen} selectedId={null}
        items={sections.flatMap(section => section.options.map(option => ({ id: option.id, title: option.label, subtitle: option.detail, disabled: option.disabled, category: section.title })))}
        onSelect={key => { const destination = destinations[Number(key)]; if (destination) void runtime.perform(sourceId, destination.targetId, destination.destination, 'chooser'); }}
        trigger={({ toggle }) => <GestureDetector gesture={handleGesture}><EntityDragGripTrigger testID={testID}
            accessibilityLabel={t('entityDragDrop.organize.grip', { item: context.binding.items.find(item => item.id === id)?.title ?? '' })}
            accessibilityHint={t('entityDragDrop.keyboard.hintsA11y')}
            onPress={toggle} onKeyDown={onKeyDown} expanded={chooserOpen}
            active={active.active} density={context.pointerInteraction ? 'pointer' : 'touch'} /></GestureDetector>} />;
    const moveBy = (delta: number) => {
        const ids = latest.current.binding.items.map(item => item.id);
        const position = entityFlatPositionAtIndex(ids, id, ids.indexOf(id) + delta);
        return position ? runtime.perform(sourceId, rowTargetId(context, position.anchorId ?? id), position, 'chooser') : Promise.resolve(null);
    };
    const contents = typeof props.children === 'function' ? props.children({ renderHandle: context.organizing || context.pointerInteraction ? handle : () => null, isDragging: active.active, moveBy })
        : <View style={{ flexDirection: 'row', alignItems: 'center' }}>{context.organizing || context.pointerInteraction ? handle() : null}<View style={{ flex: 1 }}>{props.children}</View></View>;
    const body = <View ref={rowNode} onLayout={(event: LayoutChangeEvent) => {
        registry.registerRow({ id, containerId: context.id, parentId: null, depth: 0, kind: 'leaf', bounds: event.nativeEvent.layout });
        void latest.current.measure().then(async () => {
            const row = await measureWindowBounds(rowNode.current);
            const list = latest.current.getBounds();
            if (row && list) registry.registerRow({ id, containerId: context.id, parentId: null, depth: 0, kind: 'leaf', bounds: { x: row.x - list.x, y: row.y - list.y, width: row.width, height: row.height } });
        });
    }} style={{ opacity: active.active ? HAPPIER_CARRIED_SOURCE_OPACITY : 1 }}>
        {contents}<FlatRowIndicator runtime={runtime} targetId={targetId} position={resolvedPosition} />
    </View>;
    // Lab ST4: a move its owner refused late stays under this row in words.
    return <EntityDropSettledFeedback runtime={runtime} match={settledMatch}>
        {context.pointerInteraction ? <GestureDetector gesture={gesture}>{body}</GestureDetector> : body}
    </EntityDropSettledFeedback>;
}

function FlatRowIndicator(props: Readonly<{ runtime: EntityDragDropRuntime; targetId: string; position: React.RefObject<AnchoredListPositionV1 | null> }>) {
    const edge = React.useSyncExternalStore(props.runtime.subscribe, () => {
        const snapshot = props.runtime.getSnapshot();
        if (snapshot.targetId !== props.targetId || snapshot.admission?.status !== 'allowed') return null;
        const pointer = props.runtime.getPointer();
        // Semantic admission changes only; this leaf never subscribes to pointer frames.
        return pointer ? props.position.current?.placement ?? null : null;
    }, () => null);
    return edge ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, ...(edge === 'before' ? { top: 0 } : { bottom: 0 }) }}><TreeDropIndicatorLine visual={{ kind: 'line', targetId: props.targetId, depth: 0, edge: edge === 'before' ? 'top' : 'bottom' }} indentPx={0} /></View> : null;
}

/** The staged keyboard preview, docked over the list's foot so the list never grows when a move starts. */
function FlatFeedback(props: Readonly<{ context: FlatContext; testID: string }>) {
    const snapshot = useEntityDragDropSnapshot(props.context.runtime);
    const hints = useEntityStagedMoveHints();
    const ours = props.context.binding.items.some(item => rowSourceId(props.context, item.id) === snapshot.sourceId);
    const staged = ours && (snapshot.phase === 'carrying' || snapshot.phase === 'pending');
    const outcome = staged ? describeEntityDropOutcome(snapshot) : null;
    const keyboard = props.context.runtime.getPointer() === null;
    return <>
        {outcome && keyboard ? <View pointerEvents="none" style={ENTITY_STAGED_MOVE_DOCK_PLACEMENT}>
            <EntityStagedMoveDock testID={`${props.testID}.staged`} outcome={outcome} hints={hints} />
        </View> : null}
        <PoliteAccessibilityStatus statusTestID={`${props.testID}.status`} transitionKey={JSON.stringify([snapshot.phase, snapshot.targetId, outcome])} announcement={describeHappierDropAnnouncement(outcome)} />
    </>;
}
