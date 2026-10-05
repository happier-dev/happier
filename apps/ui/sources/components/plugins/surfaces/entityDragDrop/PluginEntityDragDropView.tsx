import * as React from 'react';
import { I18nManager, Platform, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { DragSourceProps, DropTargetProps } from '@happier-dev/plugin-ui';
import { HAPPIER_CARRIED_SOURCE_OPACITY, resolveHappierDropChooserSections, resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { describeSessionListDropOutcome } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { useEntityDragDestinations, useEntityDragSourceState, useEntityDropTargetState } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { isSecondaryEntityRowControl, useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { measureWindowBounds, readWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import { EntityDragGrip, EntityStagedMoveDock } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { TreeDropOutline } from '@/components/ui/treeDragDrop/ui/TreeDropOutline';
import type { EntityDragCarry, EntityDropDestination } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import type { WindowBounds } from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
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
    const [source, setSource] = React.useState<ReturnType<PluginEntityDragDropBinding['mountSource']> | null>(null);
    const mounted = React.useRef<ReturnType<PluginEntityDragDropBinding['mountSource']> | null>(null);
    const revision = usePluginUiClientExecutableRegistrationRevision();
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        mounted.current?.dispose();
        mounted.current = props.disabled ? null : binding.mountSource({ mountId, sourceId: props.sourceId, reference: latest.current.reference });
        setSource(mounted.current);
        return () => { mounted.current?.dispose(); mounted.current = null; };
    }, [binding, mountId, props.sourceId, referenceKey, props.disabled]);
    React.useEffect(() => {
        if (props.disabled || mounted.current?.isCurrent()) return;
        mounted.current?.dispose();
        mounted.current = binding.mountSource({ mountId, sourceId: props.sourceId, reference: latest.current.reference });
        setSource(mounted.current);
    }, [binding, mountId, props.sourceId, props.disabled, revision]);
    return <MountedPluginEntityDragSource {...props} source={source} />;
}

function MountedPluginEntityDragSource(props: DragSourceProps & Readonly<{
    binding: PluginEntityDragDropBinding;
    source: ReturnType<PluginEntityDragDropBinding['mountSource']> | null;
}>) {
    const { binding, source } = props;
    const runtime = binding.runtime;
    const sourceId = source?.id ?? '';
    const state = useEntityDragSourceState(runtime, sourceId);
    const pointerInteraction = Platform.OS === 'web' && isHoverCapablePrimaryPointer();
    const enabled = source !== null && props.disabled !== true;
    const [chooserOpen, setChooserOpen] = React.useState(false);
    const [selected, setSelected] = React.useState<EntityDropDestination | null>(null);
    const keyboardCarry = React.useRef<EntityDragCarry | null>(null);
    const gestureAdapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const didEnd = React.useRef(false);
    const sourceRef = React.useRef(source);
    sourceRef.current = source;
    const attachDrag = useEntityDragDomBinding({ runtime, sourceId, enabled: enabled && pointerInteraction,
        canStart: canStartRowCarry, describe: () => runtime.describeSource(sourceId)?.title ?? '' });
    const gesture = React.useMemo(() => Gesture.Pan().minDistance(ENTITY_DRAG_ACTIVATION_DISTANCE_PX).runOnJS(true)
        .enabled(enabled && !pointerInteraction && props.organizing === true)
        .onStart(event => {
            didEnd.current = false;
            const carry = sourceRef.current?.begin('pointer');
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
    React.useEffect(() => () => {
        gestureAdapter.current?.cancel();
        keyboardCarry.current?.cancel('source-retired');
    }, [source]);
    React.useEffect(() => {
        if (props.organizing !== true) gestureAdapter.current?.cancel();
    }, [props.organizing]);

    const destinations = useEntityDragDestinations(runtime, sourceId, chooserOpen);
    const sections = resolveHappierDropChooserSections({ options: destinations.map((destination, index) => ({
        id: String(index), label: destination.label ?? (destination.admission.status === 'allowed'
            ? destination.admission.effect.preview.verb : destination.admission.reason.message),
        refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
    })), unavailableTitle: t('entityDragDrop.chooser.unavailable') });
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (!enabled || event.defaultPrevented) return;
        // This named entry owns staged movement; primary and secondary child controls keep activation.
        if (event.target !== event.currentTarget) return;
        const carrying = runtime.getSnapshot().sourceId === sourceId && runtime.getSnapshot().phase === 'carrying';
        const intent = resolveHappierStagedMoveKey({ key: event.key, repeat: event.repeat, staged: carrying, rtl: I18nManager.isRTL });
        if (!intent) return;
        event.preventDefault(); event.stopPropagation();
        if (intent === 'pickUp') {
            const carry = source?.begin('keyboard');
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
    };
    const title = runtime.describeSource(sourceId)?.title ?? '';
    const label = t('entityDragDrop.organize.grip', { item: title });
    const grip = enabled && !pointerInteraction && props.organizing === true ? <DropdownMenu
        open={chooserOpen} onOpenChange={setChooserOpen} selectedId={null}
        items={sections.flatMap(section => section.options.map(option => ({ id: option.id, title: option.label,
            subtitle: option.detail, disabled: option.disabled, category: section.title })))}
        onSelect={key => { const destination = destinations[Number(key)]; if (destination) void runtime.perform(sourceId, destination.targetId, destination.destination, 'chooser'); }}
        trigger={({ toggle }) => <GestureDetector gesture={gesture}><Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={label}>
            <EntityDragGrip active={state.active} density="touch" accessibilityLabel={label} />
        </Pressable></GestureDetector>} /> : null;
    return <View ref={attachDrag} testID={props.testID}
        style={{ opacity: state.active ? HAPPIER_CARRIED_SOURCE_OPACITY : 1 }}
        {...(Platform.OS === 'web' ? { onKeyDown, tabIndex: enabled ? 0 : undefined, role: 'group' as const, accessibilityLabel: label } : {})}>
        <View style={grip ? { flexDirection: 'row', alignItems: 'center' } : undefined}>{grip}<View style={grip ? { flex: 1, minWidth: 0 } : undefined}>{props.children}</View></View>
        <PluginSourceStagedFeedback binding={binding} sourceId={sourceId} testID={props.testID} />
    </View>;
}

function PluginSourceStagedFeedback(props: Readonly<{ binding: PluginEntityDragDropBinding; sourceId: string; testID?: string }>) {
    const runtime = props.binding.runtime;
    const snapshot = React.useSyncExternalStore(runtime.subscribe, () => {
        const current = runtime.getSnapshot();
        return current.sourceId === props.sourceId && runtime.getPointer() === null ? current : null;
    }, () => null);
    const outcome = snapshot ? describeSessionListDropOutcome({ phase: snapshot.phase, admission: snapshot.admission }) : null;
    const announcement = outcome ? [outcome.title, outcome.detail].filter(Boolean).join('. ') : '';
    return <>
        {outcome ? <EntityStagedMoveDock outcome={outcome} hints={[
            { keys: ['↑', '↓'], label: t('entityDragDrop.keyboard.choose') },
            { keys: ['Enter'], label: t('entityDragDrop.keyboard.drop') },
            { keys: ['Esc'], label: t('entityDragDrop.keyboard.cancel') },
        ]} /> : null}
        <PoliteAccessibilityStatus statusTestID={`${props.testID ?? props.sourceId}.status`}
            transitionKey={announcement} announcement={announcement} />
    </>;
}

export function PluginEntityDropTargetView(props: DropTargetProps & Readonly<{ binding: PluginEntityDragDropBinding }>) {
    const parentId = React.useContext(ParentTarget);
    const mountId = React.useId();
    const node = React.useRef<unknown>(null);
    const measured = React.useRef<WindowBounds | null>(null);
    const [targetId, setTargetId] = React.useState('');
    const mounted = React.useRef<ReturnType<PluginEntityDragDropBinding['mountTarget']> | null>(null);
    const revision = usePluginUiClientExecutableRegistrationRevision();
    const latest = React.useRef(props);
    latest.current = props;
    const { binding } = props;
    const inputKey = JSON.stringify(props.input ?? null);
    const getBounds = React.useCallback(() => readWindowBounds(toTreeDropMeasurableRef(node.current)) ?? measured.current, []);
    const refreshBounds = React.useCallback(async () => {
        measured.current = await measureWindowBounds(toTreeDropMeasurableRef(node.current));
    }, []);
    React.useEffect(() => {
        mounted.current?.dispose();
        mounted.current = props.disabled ? null : binding.mountTarget({ mountId, targetId: props.targetId, input: latest.current.input,
            getBounds, refreshBounds, parentId });
        setTargetId(mounted.current?.id ?? '');
        return () => { mounted.current?.dispose(); mounted.current = null; };
    }, [binding, mountId, props.targetId, inputKey, props.disabled, parentId, getBounds, refreshBounds]);
    React.useEffect(() => {
        if (props.disabled || mounted.current?.isCurrent()) return;
        mounted.current?.dispose();
        mounted.current = binding.mountTarget({ mountId, targetId: props.targetId, input: latest.current.input,
            getBounds, refreshBounds, parentId });
        setTargetId(mounted.current?.id ?? '');
    }, [binding, mountId, props.targetId, props.disabled, revision, parentId, getBounds, refreshBounds]);
    React.useEffect(() => {
        if (Platform.OS === 'web' || props.disabled) return;
        return binding.runtime.subscribePointer(() => { void refreshBounds().then(binding.refresh); });
    }, [binding, refreshBounds, props.disabled]);
    const attachDrop = useEntityDropDomBinding(props.disabled ? undefined : binding.runtime);
    const attach = React.useCallback((value: unknown) => { node.current = value; attachDrop(value); }, [attachDrop]);
    const snapshot = useEntityDropTargetState(binding.runtime, targetId);
    return <ParentTarget.Provider value={targetId || parentId}><View ref={attach} testID={props.testID}
        onLayout={() => { void refreshBounds().then(binding.refresh); }}>
        {props.children}
        {snapshot?.admission?.status === 'allowed' && (snapshot.phase === 'carrying' || snapshot.phase === 'pending') ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
            <TreeDropOutline visual={{ kind: 'outline', targetId }} style={{ flex: 1 }} />
        </View> : null}
    </View></ParentTarget.Provider>;
}
