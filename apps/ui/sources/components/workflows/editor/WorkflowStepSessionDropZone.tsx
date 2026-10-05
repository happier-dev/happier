import * as React from 'react';
import { View } from 'react-native';
import { useEntityDragDropRuntime, useEntityDropTarget, useEntityDropTargetState,
    measureWindowBounds, readWindowBounds, TreeDropOutline, useEntityDropDomBinding,
    type TreeDropMeasurableRef, type WindowBounds } from '@/components/ui/treeDragDrop';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';

export type { WorkflowSessionDrop } from './useWorkflowSessionBinding';

/** This leaf alone subscribes to admission; pointer frames never rerender the prompt. */
function WorkflowStepSessionTarget(props: Readonly<{
    sessionDrop: WorkflowSessionDrop;
    targetId: string;
    stepId: string;
    label: string;
    bounds: () => WindowBounds | null;
}>): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    useEntityDropTarget(runtime, {
        id: props.targetId, scope: props.sessionDrop.scope, acceptedKinds: ['session'], captureKinds: ['session'], getBounds: props.bounds,
        resolve: ({ item }) => props.sessionDrop.resolve(props.stepId, item),
        execute: props.sessionDrop.execute,
        listDestinations: () => [{ destination: null, label: props.label }],
    });
    const snapshot = useEntityDropTargetState(runtime, props.targetId);
    // Outcome/reason copy is the realm's E1 preview, never a second wrapper-local hint.
    return snapshot?.admission?.status === 'allowed' && snapshot.phase === 'carrying'
        ? <TreeDropOutline visual={{ kind: 'outline', targetId: props.targetId }}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }} /> : null;
}

/** Qualified Session binding owns the app drop; child Files remain with the composer. */
export function WorkflowStepSessionDropZone(props: Readonly<{
    stepId: string;
    label: string;
    sessionDrop?: WorkflowSessionDrop;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const runtime = useEntityDragDropRuntime();
    const targetId = React.useId();
    const host = React.useRef<View | null>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const dropRef = useEntityDropDomBinding(runtime, props.sessionDrop
        ? { captureKinds: ['session'] } : undefined);
    const measurable = React.useCallback((): TreeDropMeasurableRef | null => {
        const node = host.current;
        if (!node) return null;
        const element = node as unknown as { getBoundingClientRect?: () => DOMRect };
        return element.getBoundingClientRect ? { getBoundingClientRectFn: () => element.getBoundingClientRect!() } : node;
    }, []);
    const attach = React.useCallback((node: View | null) => {
        host.current = node;
        dropRef(node);
    }, [dropRef]);
    const bounds = React.useCallback(() => readWindowBounds(measurable()) ?? nativeBounds.current, [measurable]);
    const onLayout = React.useCallback(() => {
        const node = host.current;
        void measureWindowBounds(measurable()).then(next => {
            if (host.current !== node) return;
            nativeBounds.current = next;
            runtime.refresh();
        });
    }, [measurable, runtime]);
    return <View ref={attach} collapsable={false} testID={props.testID} onLayout={onLayout}>
        {props.children}
        {props.sessionDrop === undefined ? null : <WorkflowStepSessionTarget
            sessionDrop={props.sessionDrop} targetId={targetId} stepId={props.stepId} label={props.label} bounds={bounds} />}
    </View>;
}
