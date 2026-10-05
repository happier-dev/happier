import * as React from 'react';
import { View } from 'react-native';
import { useEntityDragDropRuntime, useEntityDropTarget, useEntityDropTargetState,
    measureWindowBounds, readWindowBounds, TreeDropOutline, useEntityDropDomBinding,
    type WindowBounds } from '@/components/ui/treeDragDrop';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';

export type { WorkflowSessionDrop } from './useWorkflowSessionBinding';

/** This leaf alone subscribes to admission; pointer frames never rerender the prompt. */
function WorkflowStepSessionTarget(props: Readonly<{
    sessionDrop: WorkflowSessionDrop;
    targetId: string;
    stepId: string;
    label: string;
    bounds: () => WindowBounds | null;
    measure: () => Promise<void>;
}>): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    useEntityDropTarget(runtime, {
        id: props.targetId, scope: props.sessionDrop.scope, acceptedKinds: ['session'], captureKinds: ['session'], getBounds: props.bounds,
        measureBounds: props.measure,
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
    const attach = React.useCallback((node: View | null) => {
        host.current = node;
        dropRef(node);
    }, [dropRef]);
    const bounds = React.useCallback(() => readWindowBounds(host.current) ?? nativeBounds.current, []);
    const measure = React.useCallback(async () => {
        const node = host.current;
        const next = await measureWindowBounds(node);
        if (host.current === node) nativeBounds.current = next;
    }, []);
    const onLayout = React.useCallback(() => {
        void measure().then(() => runtime.refresh());
    }, [measure, runtime]);
    return <View ref={attach} collapsable={false} testID={props.testID} onLayout={onLayout}>
        {props.children}
        {props.sessionDrop === undefined ? null : <WorkflowStepSessionTarget
            sessionDrop={props.sessionDrop} targetId={targetId} stepId={props.stepId} label={props.label} bounds={bounds} measure={measure} />}
    </View>;
}
