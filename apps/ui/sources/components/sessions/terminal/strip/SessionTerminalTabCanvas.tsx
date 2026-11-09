import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';

import { SplitCanvasHost, type SplitCanvasHostControls } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SplitCanvasAction, SplitCanvasLeafNode, SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

import type { SessionTerminalTabDescriptor } from '../presentation/describeSessionTerminal';
import { sessionTerminalTabToSplitCanvas } from '../sessionTerminalWorkspace';
import { registerSessionTerminalSplitMeasurements } from '../sessionTerminalWorkspaceRuntime';
import type { SessionTerminalWorkspaceViewProps } from './SessionTerminalWorkspaceView';

/** Each visited tab owns its split host for as long as the tab remains open. */
export function SessionTerminalTabCanvas(props: Readonly<{
    scopeId: string;
    tab: SessionTerminalWorkspaceV1['tabs'][number];
    descriptor: SessionTerminalTabDescriptor | null;
    active: boolean;
    minimumTerminalWidthPx: number;
    onFocusTerminal: SessionTerminalWorkspaceViewProps['onFocusTerminal'];
    onResize: SessionTerminalWorkspaceViewProps['onResize'];
    renderLeaf: SessionTerminalWorkspaceViewProps['renderLeaf'];
}>) {
    const controlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const { tab, active } = props;
    React.useEffect(() => {
        if (!active) return;
        return registerSessionTerminalSplitMeasurements(props.scopeId, (tabId) => {
            if (tabId && tabId !== tab.id) return null;
            const measurement = controlsRef.current?.readSplitMeasurement(tab.focusedTerminalId, 'right') ?? null;
            return measurement ? { availableWidthPx: measurement.availableSizePx, minimumTerminalWidthPx: measurement.minimumExistingSizePx } : null;
        }, (tabId, splitId, ratio) => (tabId === tab.id ? controlsRef.current?.resizeSplit(splitId, ratio) ?? false : false));
    }, [active, props.scopeId, tab.id, tab.focusedTerminalId]);

    const canvas = React.useMemo(() => sessionTerminalTabToSplitCanvas(tab), [tab]);
    const onCanvasAction = React.useCallback((action: SplitCanvasAction<SessionTerminalMemberV1>) => {
        if (action.type === 'focusLeaf' && action.leafId) props.onFocusTerminal(action.leafId);
        if (action.type === 'setSplitRatio' && typeof action.availableSizePx === 'number') {
            props.onResize({
                type: 'resize', tabId: tab.id, splitId: action.splitId, ratio: action.ratio,
                availableWidthPx: action.availableSizePx,
                minimumTerminalWidthPx: props.minimumTerminalWidthPx,
                ...(action.minimumFirstSizePx !== undefined ? { minimumFirstWidthPx: action.minimumFirstSizePx } : {}),
                ...(action.minimumSecondSizePx !== undefined ? { minimumSecondWidthPx: action.minimumSecondSizePx } : {}),
            });
        }
    }, [tab.id, props.minimumTerminalWidthPx, props.onFocusTerminal, props.onResize]);
    const getLeafMinimumSizePx = React.useCallback(() => ({ width: props.minimumTerminalWidthPx, height: 0 }), [props.minimumTerminalWidthPx]);
    const renderLeaf = React.useCallback((input: Readonly<{ leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>; isFocused: boolean }>) => (
        props.renderLeaf(input.leaf.payload, {
            focused: active && input.isFocused,
            descriptor: props.descriptor?.members.find((member) => member.terminalId === input.leaf.id) ?? null,
        })
    ), [active, props.descriptor, props.renderLeaf]);

    return <TypedTerminalSplitCanvasHost state={canvas} dispatch={onCanvasAction} renderLeaf={renderLeaf}
        getLeafMinimumSizePx={getLeafMinimumSizePx} controlsRef={controlsRef} keyboardEnabled={false} chrome="flat" />;
}

const TypedTerminalSplitCanvasHost = SplitCanvasHost as unknown as React.ComponentType<Readonly<{
    state: SplitCanvasState<SessionTerminalMemberV1>;
    dispatch: (action: SplitCanvasAction<SessionTerminalMemberV1>) => void;
    renderLeaf: (input: Readonly<{ leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>; isFocused: boolean; isMaximized: boolean }>) => React.ReactNode;
    getLeafMinimumSizePx: (leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>) => Readonly<{ width: number; height: number }>;
    controlsRef: React.MutableRefObject<SplitCanvasHostControls | null>;
    keyboardEnabled: boolean;
    chrome: 'framed' | 'flat';
}>>;
