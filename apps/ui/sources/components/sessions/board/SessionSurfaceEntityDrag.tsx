import * as React from 'react';
import { I18nManager, Platform, Pressable, View, type ScrollView, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { EntityDragItemV1, EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { EntityDragGrip, EntityStagedMoveDock } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { createEntityDragGestureAdapter, useEntityDragDomBinding, useEntityDropDomBinding, useEntityDragDropRuntime, useEntityDragDropSnapshot, useEntityDragSourceState, useEntityDropTargetState, TreeDropIndicatorLine, TreeDropOutline, type EntityDragCarry, type EntityDropDestination, type EntityDropTarget, type WindowBounds } from '@/components/ui/treeDragDrop';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { measureWindowBounds, readWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/treeDropRegistryTypes';
import { t } from '@/text';
import { CurrentSessionPresentationActionInputV1Schema, type SessionCompanionPresentationItemRefV1 } from '@happier-dev/protocol/sessions';
import { resolveSessionSurfaceIndicatorEdge } from './sessionSurfaceIndicatorEdge';
import { executeWidgetEntityMovement } from '@/sync/ops/actions/widgetEntityMovement';
import { resolveSessionSurfaceKeyboardRoute } from './sessionSurfaceKeyboardDestination';
import { useEntityDragChooser } from '@/components/ui/treeDragDrop/useEntityDragChooser';

export type SessionSurfaceEntityBinding = Readonly<{
    scope: EntityDragScopeV1;
    isCurrent(): boolean;
    getItem(): EntityDragItemV1 | null;
    title: string;
    admitWidgetMovement?: (effect: import('@happier-dev/protocol/plugins/ui').EntityDropEffectV1) => import('@happier-dev/protocol/plugins/ui').EntityDropAdmissionV1;
    target?: Omit<EntityDropTarget, 'id' | 'scope' | 'getBounds' | 'isCurrent'>;
    /** Content-coordinate owner supplies current native bounds after scroll/resize. */
    getNativeBounds?: () => WindowBounds | null;
    getCompanionTarget?: () => Readonly<{ itemKey: string; items: readonly SessionCompanionPresentationItemRefV1[] }>;
    getBoardTarget?: () => NonNullable<Parameters<typeof resolveSessionSurfaceIndicatorEdge>[0]['boardTarget']>;
    pointerDestination?: (bounds: WindowBounds, pointer: Readonly<{ x: number; y: number }>) => import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1;
    keyboardDestination?: (intent: 'previous' | 'next' | 'in' | 'out', selected: EntityDropDestination | null, destinations: readonly EntityDropDestination[]) => EntityDropDestination | null;
}>;

export function sessionSurfaceMeasurable(node: unknown): TreeDropMeasurableRef | null {
    return toTreeDropMeasurableRef(node);
}

/** Mount-only adapter: the realm runtime owns the source, selection, cancellation and execution. */
export function useSessionSurfaceEntityDrag(binding: SessionSurfaceEntityBinding | null) {
    const runtime = useEntityDragDropRuntime();
    const instance = React.useId();
    const sourceId = `session-surface-source:${instance}`;
    const targetId = `session-surface-target:${instance}`;
    const node = React.useRef<View | ScrollView>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const latest = React.useRef(binding); latest.current = binding;
    const dragDom = useEntityDragDomBinding({ runtime, sourceId, enabled: binding !== null && binding.getItem() !== null && isHoverCapablePrimaryPointer(),
        describe: () => latest.current?.title ?? '',
        canStart: event => {
            const element = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null;
            return !element?.closest('button,input,textarea,a,[role="button"],[contenteditable="true"]')
                && !(typeof window !== 'undefined' && window.getSelection()?.toString());
        },
    });
    const dropDom = useEntityDropDomBinding(binding?.target ? runtime : undefined);
    const ref = React.useCallback((value: View | ScrollView | null) => { node.current = value; dragDom(value); dropDom(value); }, [dragDom, dropDom]);
    const bounds = React.useCallback(() => readWindowBounds(sessionSurfaceMeasurable(node.current))
        ?? latest.current?.getNativeBounds?.() ?? nativeBounds.current, []);
    const measure = React.useCallback(() => {
        void measureWindowBounds(sessionSurfaceMeasurable(node.current)).then(value => { nativeBounds.current = value; runtime.refresh(); });
    }, [runtime]);
    React.useEffect(() => {
        if (!binding) return;
        const scope = binding.scope;
        const current = () => latest.current?.scope.serverId === scope.serverId
            && latest.current.scope.accountId === scope.accountId && latest.current.isCurrent();
        const source = runtime.registerSource({ id: sourceId, scope, isCurrent: current,
            getItem: () => latest.current?.getItem() ?? null, describe: () => latest.current ? { title: latest.current.title } : null });
        const target = binding.target ? runtime.registerTarget({ id: targetId, scope, getBounds: bounds, isCurrent: current,
            get parentId() { return latest.current?.target?.parentId; },
            get acceptedKinds() { return latest.current?.target?.acceptedKinds ?? []; },
            listDestinations: item => latest.current?.target?.listDestinations?.(item) ?? [],
            resolve: context => {
                const rectangle = bounds();
                const destination = context.pointer && rectangle && latest.current?.pointerDestination
                    ? latest.current.pointerDestination(rectangle, context.pointer) : context.destination;
                const admission = latest.current?.target?.resolve({ ...context, destination }) ?? { status: 'refused' as const, reason: { code: 'target-gone', message: t('entityDragDrop.reasons.gone') } };
                return admission.status === 'allowed' && admission.effect.actionId === 'widgets.instance.move'
                    ? latest.current?.admitWidgetMovement?.(admission.effect) ?? { status: 'refused', reason: { code: 'widget_admission_unavailable', message: t('entityDragDrop.surface.widgetMoveUnavailable') } }
                    : admission;
            },
            execute: effect => effect.actionId === 'widgets.instance.move' ? executeWidgetEntityMovement(effect, scope)
                : latest.current?.target?.execute(effect) ?? Promise.resolve({ status: 'refused', reason: { code: 'target-gone', message: t('entityDragDrop.reasons.gone') } }),
            autoscroll: pointer => latest.current?.target?.autoscroll?.(pointer),
            containsPointer: pointer => latest.current?.target?.containsPointer?.(pointer) !== false,
        }) : null;
        return () => { source(); target?.(); };
    }, [runtime, sourceId, targetId, binding?.scope.serverId, binding?.scope.accountId, binding !== null, binding?.target !== undefined, bounds]);
    const adapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const gesture = React.useMemo(() => Gesture.Pan().minDistance(6).runOnJS(true)
        .onStart(event => {
            const carry = runtime.begin(sourceId, 'pointer');
            adapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            adapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
        })
        .onUpdate(event => { adapter.current?.update({ x: event.absoluteX, y: event.absoluteY }); runtime.autoscroll(); })
        .onEnd((event, success) => { void adapter.current?.end(success, { x: event.absoluteX, y: event.absoluteY }); })
        .onFinalize(() => adapter.current?.finalize()), [runtime, sourceId]);
    React.useEffect(() => () => adapter.current?.cancel(), []);
    const refresh = React.useCallback(() => { measure(); runtime.refresh(); }, [measure, runtime]);
    const onLayout = React.useCallback((_event?: LayoutChangeEvent) => refresh(), [refresh]);
    const keyboardDestination = React.useCallback((intent: 'previous' | 'next' | 'in' | 'out', selected: EntityDropDestination | null) => {
        return resolveSessionSurfaceKeyboardRoute({ intent, selected, destinations: runtime.getDestinations(sourceId), sourceTargetId: targetId,
            resolveLocal: latest.current?.keyboardDestination });
    }, [runtime, sourceId, targetId]);
    const getCompanionTarget = React.useCallback(() => latest.current?.getCompanionTarget?.(), []);
    const getBoardTarget = React.useCallback(() => latest.current?.getBoardTarget?.(), []);
    return { runtime, sourceId, targetId, node, ref, gesture, onLayout, refresh, getBounds: bounds, keyboardDestination, getCompanionTarget, getBoardTarget };
}

export type SessionSurfaceEntityDrag = ReturnType<typeof useSessionSurfaceEntityDrag>;

/** Called once at each scroll/rail owner, not once for every card. */
export function useSessionSurfaceGeometryRefresh(refresh: () => void) {
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        window.addEventListener('scroll', refresh, true);
        window.addEventListener('resize', refresh);
        return () => { window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); };
    }, [refresh]);
}

/** Shared grip/chooser/dock; arrows stage the same semantic destination that a pointer resolves. */
export function SessionSurfaceEntityDragHandle(props: Readonly<{ drag: SessionSurfaceEntityDrag; title: string; testID: string }>) {
    const { runtime, sourceId } = props.drag;
    const state = useEntityDragSourceState(runtime, sourceId);
    const chooser = useEntityDragChooser(runtime, sourceId);
    const { open, onOpenChange } = chooser;
    const carry = React.useRef<EntityDragCarry | null>(null);
    const selected = React.useRef<EntityDropDestination | null>(null);
    const destinations = open || state.active ? runtime.getDestinations(sourceId) : [];
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? t('entityDragDrop.organize.title'), group: destination.group,
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    const onKeyDown = (event: { key: string; repeat?: boolean; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void }) => {
        if (chooser.onMenuKeyDown(event)) return;
        const staged = runtime.getSnapshot().phase === 'carrying' && runtime.getSnapshot().sourceId === sourceId;
        const intent = resolveHappierStagedMoveKey({ key: event.key, repeat: event.repeat, staged, rtl: I18nManager.isRTL });
        if (!intent) return;
        event.preventDefault(); event.stopPropagation();
        if (intent === 'pickUp') { carry.current = runtime.begin(sourceId, 'keyboard'); selected.current = null; }
        else if (intent === 'cancel') { runtime.cancel('keyboard-escape'); carry.current = null; selected.current = null; }
        else if (intent === 'drop') { void carry.current?.release(); carry.current = null; }
        else {
            const destination = props.drag.keyboardDestination(intent, selected.current);
            selected.current = destination;
            if (destination) carry.current?.choose(destination.targetId, destination.destination);
            else carry.current?.move(null);
        }
    };
    return <>
        <DropdownMenu open={open} onOpenChange={onOpenChange} selectedId={null} closeOnSelect={false}
            items={sections.flatMap(section => section.options.map(option => ({ id: option.id, title: option.label, subtitle: option.detail, disabled: option.disabled, category: section.title })))}
            onSelect={id => chooser.select(destinations[Number(id)])}
            trigger={({ toggle }) => <GestureDetector gesture={props.drag.gesture}><Pressable testID={props.testID}
                accessibilityRole="button" accessibilityLabel={t('entityDragDrop.organize.grip', { item: props.title })}
                onPress={toggle} {...(Platform.OS === 'web' ? { onKeyDown, tabIndex: 0, 'aria-grabbed': state.active } : {})}>
                <EntityDragGrip active={state.active} accessibilityLabel={t('entityDragDrop.organize.grip', { item: props.title })} />
            </Pressable></GestureDetector>} />
    </>;
}

export function SessionSurfaceEntityFeedback(props: Readonly<{ kind: 'session-board-item' | 'companion-item' | 'home-section'; scope: EntityDragScopeV1 | null; address: import('@/sync/domains/session/sessionAddress').SessionAddress | null; testID: string }>) {
    const runtime = useEntityDragDropRuntime();
    // Leaf-only semantic subscription: neither the Board nor the rail subscribes to pointer frames.
    const snapshot = useEntityDragDropSnapshot(runtime);
    if ((snapshot.phase !== 'carrying' && snapshot.phase !== 'pending' && snapshot.phase !== 'settled')
        || snapshot.item?.kind !== props.kind || !props.scope
        || snapshot.item.scope.serverId !== props.scope.serverId || snapshot.item.scope.accountId !== props.scope.accountId
        || snapshot.item.kind !== 'home-section' && (!('address' in snapshot.item) || !props.address || snapshot.item.address.sessionId !== props.address.sessionId)
        || runtime.getPointer() !== null || !snapshot.admission) return null;
    const admission = snapshot.admission;
    const copy = admission.status === 'allowed' && admission.effect.actionId === 'session.presentation.apply'
        && CurrentSessionPresentationActionInputV1Schema.safeParse(admission.effect.input).data?.intent.kind === 'companion.item.add';
    const outcome = snapshot.phase === 'pending'
        ? { tone: 'pending' as const, title: admission.status === 'allowed' ? admission.effect.preview.verb : t('entityDragDrop.organize.title'), detail: t('entityDragDrop.preview.pendingDetail') }
        : snapshot.outcome?.status === 'unknown'
        ? { tone: 'pending' as const, title: t('entityDragDrop.preview.unknownTitle'), detail: t('entityDragDrop.preview.unknownDetail') }
        : snapshot.outcome?.status === 'refused' ? { tone: 'refused' as const, glyph: 'refused' as const, title: t('entityDragDrop.preview.cantMoveHere'), detail: snapshot.outcome.reason?.message }
        : admission.status === 'allowed'
        ? { tone: 'allowed' as const, glyph: copy ? 'copy' as const : 'above' as const, title: admission.effect.preview.verb, detail: admission.effect.preview.consequence ?? admission.effect.preview.target }
        : { tone: 'refused' as const, glyph: 'refused' as const, title: t('entityDragDrop.preview.cantMoveHere'), detail: [admission.preview?.target, admission.reason.message].filter(Boolean).join(' · ') };
    return <View>
        <EntityStagedMoveDock outcome={outcome} hints={[{ keys: ['↵'], label: t('entityDragDrop.keyboard.drop') }, { keys: [t('entityDragDrop.keyboard.escapeKey')], label: t('entityDragDrop.keyboard.cancel') }]} testID={`${props.testID}-preview`} />
        <PoliteAccessibilityStatus announcement={[outcome.title, outcome.detail].filter(Boolean).join(' · ')} transitionKey={JSON.stringify(admission)} statusTestID={`${props.testID}-live-region`} />
    </View>;
}

/** Target feedback is a leaf; pointer frames never rerender the card or list owner. */
export function SessionSurfaceEntityTargetFeedback(props: Readonly<{ drag: SessionSurfaceEntityDrag; testID: string }>) {
    const selected = useEntityDropTargetState(props.drag.runtime, props.drag.targetId);
    if (!selected || selected.phase !== 'carrying' || selected.admission?.status !== 'allowed') return null;
    const effect = selected.admission.effect;
    const presentation = CurrentSessionPresentationActionInputV1Schema.safeParse(effect.input);
    const isCopy = effect.actionId === 'session.presentation.apply' && presentation.success && presentation.data.intent.kind === 'companion.item.add';
    const bounds = props.drag.getBounds();
    const pointer = props.drag.runtime.getPointer();
    const companionTarget = props.drag.getCompanionTarget();
    const boardTarget = props.drag.getBoardTarget();
    const edge = resolveSessionSurfaceIndicatorEdge({ effect, bounds, pointer, ...(companionTarget ? { companionTarget } : {}), ...(boardTarget ? { boardTarget } : {}) });
    const outline = isCopy || effect.actionId === 'widgets.instance.move' && !edge;
    if (!outline && !edge) return null;
    return <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        {outline ? <TreeDropOutline testID={`${props.testID}-drop-outline`} visual={{ kind: 'outline', targetId: props.drag.targetId }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
        : <TreeDropIndicatorLine testID={`${props.testID}-drop-line`} visual={{ kind: 'line', targetId: props.drag.targetId, edge: edge ?? 'bottom', depth: 0 }} indentPx={0} style={{ position: 'absolute', left: 0, right: 0, ...(edge === 'top' ? { top: 0 } : { bottom: 0 }) }} />}
    </View>;
}
