import * as React from 'react';
import { I18nManager, Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { DragSourceProps, DropTargetProps } from '@happier-dev/plugin-ui';
import { HAPPIER_CARRIED_SOURCE_OPACITY, HappierRowOperationContext, describeHappierDropAnnouncement, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { EntityDragGripChooser } from '@/components/ui/treeDragDrop/ui/EntityDragGripChooser';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { useEntityDragSourceState, useEntityDropTargetState } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { useEntityDragChooser } from '@/components/ui/treeDragDrop/useEntityDragChooser';
import { useSessionListMoveSheet } from '@/components/sessions/shell/move-sheet/useSessionListMoveSheet';
import { isSecondaryEntityRowControl, useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { measureWindowBounds, readWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import { EntityDragGripTrigger, EntityStagedMoveDock, useEntityStagedMoveHints } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { EntityDropSettledFeedback } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import { useEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { TreeDropOutline } from '@/components/ui/treeDragDrop/ui/TreeDropOutline';
import type { EntityDragCarry, EntityDropDestination } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import type { WindowBounds } from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { t } from '@/text';

import type { PluginEntityDragDropBinding } from './pluginEntityDragDropBinding';

const ParentTarget = React.createContext<string | undefined>(undefined);

function canStartRowCarry(event: DragEvent, host: HTMLElement): boolean {
    return !isSecondaryEntityRowControl(event, host) && !window.getSelection()?.toString();
}

/** Presentation/input adapter only. All registration, admission and writes remain with the mount binding. */
export function PluginEntityDragSourceView(props: DragSourceProps & Readonly<{ binding: PluginEntityDragDropBinding }>) {
    const { binding } = props;
    const mountId = React.useId();
    const referenceKey = JSON.stringify(props.reference);
    const mounted = React.useRef<ReturnType<PluginEntityDragDropBinding['mountSource']>>(null);
    const revision = usePluginUiClientExecutableRegistrationRevision();
    const reference = React.useRef(props.reference);
    reference.current = props.reference;
    const prepared = React.useMemo(() => props.disabled ? null : binding.prepareSource({
        mountId, sourceId: props.sourceId, reference: reference.current,
    }), [binding, mountId, props.sourceId, referenceKey, props.disabled, revision]);
    const latest = React.useRef(prepared);
    latest.current = prepared;
    const runtime = binding.runtime;
    const sourceId = prepared?.id ?? '';
    const state = useEntityDragSourceState(runtime, sourceId);
    const pointerInteraction = useHoverCapablePrimaryPointer();
    const enabled = prepared !== null;
    const chooser = useEntityDragChooser(runtime, sourceId);
    const chooserOpen = chooser.open;
    const setChooserOpen = chooser.onOpenChange;
    const { openMoveSheet } = useSessionListMoveSheet();
    const [selected, setSelected] = React.useState<EntityDropDestination | null>(null);
    const keyboardCarry = React.useRef<EntityDragCarry | null>(null);
    const gestureAdapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const didEnd = React.useRef(false);
    const retire = React.useCallback(() => {
        mounted.current?.dispose();
        mounted.current = null;
        gestureAdapter.current?.cancel();
        keyboardCarry.current?.cancel('source-retired');
    }, []);
    React.useEffect(() => {
        mounted.current = latest.current?.register() ?? null;
        return retire;
    }, [binding, mountId, props.sourceId, referenceKey, props.disabled, retire]);
    React.useEffect(() => {
        if (props.disabled || mounted.current?.isCurrent()) return;
        retire();
        mounted.current = latest.current?.register() ?? null;
    }, [binding, mountId, props.sourceId, props.disabled, retire, revision]);
    const onDropOutcome = React.useRef(props.onDropOutcome);
    onDropOutcome.current = props.onDropOutcome;
    React.useEffect(() => {
        let settled = false;
        return runtime.subscribe(() => {
            const snapshot = runtime.getSnapshot();
            if (snapshot.sourceId === sourceId && snapshot.phase === 'settled' && snapshot.outcome) {
                if (!settled) { settled = true; onDropOutcome.current?.(snapshot.outcome); }
            } else settled = false;
        });
    }, [runtime, sourceId]);
    const attachDrag = useEntityDragDomBinding({ runtime, sourceId, enabled: enabled && pointerInteraction,
        canStart: canStartRowCarry, describe: () => runtime.describeSource(sourceId)?.title ?? '' });
    const gesture = React.useMemo(() => Gesture.Pan().minDistance(ENTITY_DRAG_ACTIVATION_DISTANCE_PX).runOnJS(true)
        .enabled(enabled && !pointerInteraction && props.organizing === true)
        .onStart(event => {
            didEnd.current = false;
            const carry = mounted.current?.begin('pointer');
            gestureAdapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            gestureAdapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
        })
        .onUpdate(event => {
            gestureAdapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
            runtime.autoscroll();
        })
        .onEnd((event, success) => {
            didEnd.current = true;
            const adapter = gestureAdapter.current;
            if (!adapter) return;
            if (!success) { void adapter.end(false); return; }
            void adapter.end(true, { x: event.absoluteX, y: event.absoluteY });
        })
        .onFinalize(() => { if (!didEnd.current) gestureAdapter.current?.finalize(); }),
    [binding, runtime, enabled, pointerInteraction, props.organizing]);
    React.useEffect(() => {
        if (props.organizing !== true) gestureAdapter.current?.cancel();
    }, [props.organizing]);

    const destinations = chooser.destinations;
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? (destination.admission.status === 'allowed'
            ? destination.admission.effect.preview.verb : destination.admission.reason.message),
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    const handleStagedKey = (key: string, repeat: boolean): boolean => {
        if (!enabled) return false;
        const carrying = runtime.getSnapshot().sourceId === sourceId && runtime.getSnapshot().phase === 'carrying';
        const intent = resolveHappierStagedMoveKey({ key, repeat, staged: carrying, rtl: I18nManager.isRTL });
        if (!intent) return false;
        if (intent === 'pickUp') {
            const carry = mounted.current?.begin('keyboard');
            keyboardCarry.current = carry ?? null;
            const destination = runtime.getDestinations(sourceId)[0] ?? null;
            setSelected(destination);
            if (destination) carry?.choose(destination.targetId, destination.destination);
        } else if (intent === 'cancel') {
            keyboardCarry.current?.cancel('keyboard-escape'); keyboardCarry.current = null; setSelected(null);
        } else if (intent === 'drop') {
            void keyboardCarry.current?.release(); keyboardCarry.current = null; setSelected(null);
        } else if (intent === 'previous' || intent === 'next') {
            const current = runtime.getDestinations(sourceId);
            const index = selected ? current.findIndex(option => option.targetId === selected.targetId
                && JSON.stringify(option.destination) === JSON.stringify(selected.destination)) : -1;
            const destination = current[Math.max(0, Math.min(current.length - 1, index + (intent === 'previous' ? -1 : 1)))];
            if (destination) { setSelected(destination); keyboardCarry.current?.choose(destination.targetId, destination.destination); }
        }
        return true;
    };
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.defaultPrevented || event.target !== event.currentTarget || !handleStagedKey(event.key, event.repeat)) return;
        event.preventDefault(); event.stopPropagation();
    };
    const title = prepared?.describe()?.title ?? '';
    const label = t('entityDragDrop.organize.grip', { item: title });
    const isKeyboardCarrying = () => {
        const snapshot = runtime.getSnapshot();
        return keyboardCarry.current !== null && snapshot.sourceId === sourceId && snapshot.phase === 'carrying' && runtime.getPointer() === null;
    };
    const rowOperation = {
        // A row menu item: the menu already names its row, so the verb alone (the grip keeps the full name).
        id: 'entity.move', label: t('commandPalette.hints.move'), disabled: !enabled,
        onSelect: () => { if (!isKeyboardCarrying()) handleStagedKey(' ', false); },
        onKeyDown: (key: string, event: unknown) => {
            const input = event as Readonly<{ repeat?: boolean }>;
            return isKeyboardCarrying() && handleStagedKey(key, input.repeat === true);
        },
        additionalOperations: [{ id: 'entity.mentionInComposer', label: t('entityDragDrop.composer.mentionInComposer'), disabled: !enabled,
            onSelect: () => { void openMoveSheet({ runtime, sourceLabel: title, composerOnly: true,
                prepareSource: () => mounted.current ? { sourceId: mounted.current.id, dispose: () => {} } : null }); } }],
    };
    const grip = enabled && !pointerInteraction && props.organizing === true ? <EntityDragGripChooser
        open={chooserOpen} onOpenChange={setChooserOpen} sections={sections}
        onSelect={key => { void chooser.select(destinations[Number(key)]); }}
        trigger={({ toggle }) => <GestureDetector gesture={gesture}><EntityDragGripTrigger onPress={toggle} accessibilityLabel={label}
            active={state.active} density="touch" expanded={chooserOpen} tabIndex={props.tabIndex} /></GestureDetector>} /> : null;
    const settledMatch = React.useMemo(() => ({ sourceId }), [sourceId]);
    return <EntityDropSettledFeedback runtime={runtime} match={settledMatch} {...(props.testID ? { testID: props.testID } : {})}>
        <HappierRowOperationContext.Provider value={rowOperation}><View ref={attachDrag} testID={props.testID}
            style={{ opacity: state.active ? HAPPIER_CARRIED_SOURCE_OPACITY : 1 }}
            {...(Platform.OS === 'web' ? { onKeyDown, tabIndex: enabled ? props.tabIndex ?? 0 : undefined, role: 'group' as const, accessibilityLabel: label } : {})}>
            <View style={grip ? { flexDirection: 'row', alignItems: 'center' } : undefined}>{grip}<View style={grip ? { flex: 1, minWidth: 0 } : undefined}>{props.children}</View></View>
            <PluginSourceStagedFeedback binding={binding} sourceId={sourceId} testID={props.testID} />
        </View></HappierRowOperationContext.Provider>
    </EntityDropSettledFeedback>;
}

function PluginSourceStagedFeedback(props: Readonly<{ binding: PluginEntityDragDropBinding; sourceId: string; testID?: string }>) {
    const runtime = props.binding.runtime;
    const snapshot = React.useSyncExternalStore(runtime.subscribe, () => {
        const current = runtime.getSnapshot();
        return current.sourceId === props.sourceId && runtime.getPointer() === null ? current : null;
    }, () => null);
    const hints = useEntityStagedMoveHints();
    const staged = snapshot && (snapshot.phase === 'carrying' || snapshot.phase === 'pending') ? snapshot : null;
    const outcome = useEntityDropOutcome(staged);
    const announcement = describeHappierDropAnnouncement(outcome);
    return <>
        {outcome ? <EntityStagedMoveDock outcome={outcome} hints={hints} /> : null}
        <PoliteAccessibilityStatus statusTestID={`${props.testID ?? props.sourceId}.status`}
            transitionKey={announcement} announcement={announcement} />
    </>;
}

export function PluginEntityDropTargetView(props: DropTargetProps & Readonly<{ binding: PluginEntityDragDropBinding }>) {
    const parentId = React.useContext(ParentTarget);
    const mountId = React.useId();
    const node = React.useRef<unknown>(null);
    const measured = React.useRef<WindowBounds | null>(null);
    const mounted = React.useRef<ReturnType<PluginEntityDragDropBinding['mountTarget']> | null>(null);
    const revision = usePluginUiClientExecutableRegistrationRevision();
    const input = React.useRef(props.input);
    input.current = props.input;
    const { binding } = props;
    const inputKey = JSON.stringify(props.input ?? null);
    const getBounds = React.useCallback(() => readWindowBounds(toTreeDropMeasurableRef(node.current)) ?? measured.current, []);
    const refreshBounds = React.useCallback(async () => {
        measured.current = await measureWindowBounds(toTreeDropMeasurableRef(node.current));
    }, []);
    const prepared = React.useMemo(() => props.disabled ? null : binding.prepareTarget({
        mountId, targetId: props.targetId, input: input.current, getBounds, refreshBounds, parentId,
    }), [binding, mountId, props.targetId, inputKey, props.disabled, parentId, getBounds, refreshBounds, revision]);
    const latest = React.useRef(prepared);
    latest.current = prepared;
    const targetId = prepared?.id ?? '';
    React.useEffect(() => {
        mounted.current = latest.current?.register() ?? null;
        return () => { mounted.current?.dispose(); mounted.current = null; };
    }, [binding, mountId, props.targetId, inputKey, props.disabled, parentId, getBounds, refreshBounds]);
    React.useEffect(() => {
        if (props.disabled || mounted.current?.isCurrent()) return;
        mounted.current?.dispose();
        mounted.current = latest.current?.register() ?? null;
    }, [binding, mountId, props.targetId, props.disabled, revision, parentId, getBounds, refreshBounds]);
    const attachDrop = useEntityDropDomBinding(props.disabled ? undefined : binding.runtime);
    const attach = React.useCallback((value: unknown) => { node.current = value; attachDrop(value); }, [attachDrop]);
    const snapshot = useEntityDropTargetState(binding.runtime, targetId);
    return <ParentTarget.Provider value={targetId || parentId}><View ref={attach} testID={props.testID} style={props.style}
        onLayout={() => { void refreshBounds().then(binding.refresh); }}>
        {props.children}
        {snapshot?.admission?.status === 'allowed' && (snapshot.phase === 'carrying' || snapshot.phase === 'pending') ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
            <TreeDropOutline visual={{ kind: 'outline', targetId }} style={{ flex: 1 }} />
        </View> : null}
    </View></ParentTarget.Provider>;
}
