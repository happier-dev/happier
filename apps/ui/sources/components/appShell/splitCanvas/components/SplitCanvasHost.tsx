import * as React from 'react';
import { View } from 'react-native';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { SplitCanvasDivider } from './SplitCanvasDivider';
import { SplitCanvasDropOverlay } from './SplitCanvasDropOverlay';
import { SplitCanvasLeafFrame } from './SplitCanvasLeafFrame';
import { useSplitCanvasDnD } from '../hooks/useSplitCanvasDnD';
import { useSplitCanvasInputModality } from '../hooks/useSplitCanvasInputModality';
import { useSplitCanvasKeyboard } from '../hooks/useSplitCanvasKeyboard';
import type {
    SplitCanvasAction,
    SplitCanvasAxis,
    SplitCanvasDirection,
    SplitCanvasDropTarget,
    SplitCanvasLeafHostRef,
    SplitCanvasLeafNode,
    SplitCanvasNode,
    SplitCanvasState,
} from '../model/splitCanvasTypes';
import { countSplitCanvasLeaves, splitCanvasSubtreeContainsLeaf } from '../model/splitCanvasTree';

function resolveFlexDirection(axis: SplitCanvasAxis): 'row' | 'column' {
    return axis === 'row' ? 'row' : 'column';
}

function roundRatio(value: number): number {
    return Number(value.toFixed(4));
}

const hostRootStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
} as const;

const leafContentContainerStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
} as const;

export const SplitCanvasHost = React.memo(<TLeafPayload,>(props: Readonly<{
    state: SplitCanvasState<TLeafPayload>;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    renderLeaf: (input: Readonly<{
        leaf: SplitCanvasLeafNode<TLeafPayload>;
        isFocused: boolean;
        isMaximized: boolean;
    }>) => React.ReactNode;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => string;
    onRequestSplitLeaf?: (input: Readonly<{
        leafId: string;
        direction: SplitCanvasDirection;
    }>) => void;
    activeDropTarget?: SplitCanvasDropTarget | null;
    onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
    onLeafDrop?: (input: Readonly<{
        payload: string;
        target: SplitCanvasDropTarget;
    }>) => void;
    keyboardEnabled?: boolean;
}>) => {
    const keyboardEnabled = props.keyboardEnabled ?? true;
    const inputModality = useSplitCanvasInputModality(keyboardEnabled);
    const leafCount = countSplitCanvasLeaves(props.state.root);
    const hasMultipleLeaves = leafCount > 1;
    const latestActiveDropTargetChangeRef = React.useRef(props.onActiveDropTargetChange);
    latestActiveDropTargetChangeRef.current = props.onActiveDropTargetChange;
    const handleKeyboardSplit = React.useCallback((leafId: string, direction: SplitCanvasDirection) => {
        props.onRequestSplitLeaf?.({ leafId, direction });
    }, [props.onRequestSplitLeaf]);

    useSplitCanvasKeyboard({
        enabled: keyboardEnabled,
        state: props.state,
        dispatch: props.dispatch,
        onSplit: props.onRequestSplitLeaf ? handleKeyboardSplit : undefined,
    });

    const splitCanvasDnD = useSplitCanvasDnD({
        enabled: typeof props.onActiveDropTargetChange === 'function' && typeof props.onLeafDrop === 'function',
        onActiveDropTargetChange: props.onActiveDropTargetChange,
        onLeafDrop: props.onLeafDrop,
    });

    React.useEffect(() => {
        if (!splitCanvasDnD.enabled || typeof window === 'undefined') {
            return;
        }

        const clearDropTarget = () => {
            latestActiveDropTargetChangeRef.current?.(null);
        };

        window.addEventListener('dragend', clearDropTarget);
        window.addEventListener('drop', clearDropTarget);
        return () => {
            window.removeEventListener('dragend', clearDropTarget);
            window.removeEventListener('drop', clearDropTarget);
        };
    }, [splitCanvasDnD.enabled]);

    const renderNode = React.useCallback((node: SplitCanvasNode<TLeafPayload>): React.ReactNode => {
        if (node.kind === 'leaf') {
            const target = props.activeDropTarget?.leafId === node.id ? props.activeDropTarget : null;
            const isFocused = props.state.focusedLeafId === node.id;
            const isMaximized = props.state.maximizedLeafId === node.id;
            return (
                <SplitCanvasLeafRenderer
                    key={node.id}
                    leaf={node}
                    target={target}
                    isFocused={isFocused}
                    isMaximized={isMaximized}
                    hasMultipleLeaves={hasMultipleLeaves}
                    inputModality={inputModality}
                    dispatch={props.dispatch}
                    renderLeaf={props.renderLeaf}
                    renderLeafLabel={props.renderLeafLabel}
                    onLeafLayout={splitCanvasDnD.onLeafLayout}
                    registerLeafHost={splitCanvasDnD.registerLeafHost}
                />
            );
        }

        return (
            <SplitNodeRenderer
                key={node.id}
                node={node}
                maximizedLeafId={props.state.maximizedLeafId}
                dispatch={props.dispatch}
                renderNode={renderNode}
            />
        );
    }, [
        hasMultipleLeaves,
        inputModality,
        props.activeDropTarget,
        props.dispatch,
        props.renderLeaf,
        props.renderLeafLabel,
        props.state.focusedLeafId,
        props.state.maximizedLeafId,
        splitCanvasDnD.onLeafLayout,
        splitCanvasDnD.registerLeafHost,
    ]);

    if (!props.state.root) return null;

    return (
        <WebDropTargetView
            testID="split-canvas-host"
            onLayout={splitCanvasDnD.onHostLayout}
            {...splitCanvasDnD.hostDropTargetProps}
            style={hostRootStyle}
        >
            {renderNode(props.state.root)}
        </WebDropTargetView>
    );
});

function SplitCanvasLeafRendererInner<TLeafPayload>(props: Readonly<{
    leaf: SplitCanvasLeafNode<TLeafPayload>;
    target: SplitCanvasDropTarget | null;
    isFocused: boolean;
    isMaximized: boolean;
    hasMultipleLeaves: boolean;
    inputModality: 'pointer' | 'keyboard';
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    renderLeaf: (input: Readonly<{
        leaf: SplitCanvasLeafNode<TLeafPayload>;
        isFocused: boolean;
        isMaximized: boolean;
    }>) => React.ReactNode;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => string;
    onLeafLayout: (leafId: string, event: any) => void;
    registerLeafHost: (leafId: string, host: SplitCanvasLeafHostRef | null) => void;
}>) {
    const handleLayout = React.useCallback((event: any) => {
        props.onLeafLayout(props.leaf.id, event);
    }, [props.leaf.id, props.onLeafLayout]);

    const handleHostRefChange = React.useCallback((host: SplitCanvasLeafHostRef | null) => {
        props.registerLeafHost(props.leaf.id, host);
    }, [props.leaf.id, props.registerLeafHost]);

    const handleFocus = React.useCallback(() => {
        props.dispatch({ type: 'focusLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);

    const handleClose = React.useCallback(() => {
        props.dispatch({ type: 'closeLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);

    const handleToggleMaximize = React.useCallback(() => {
        props.dispatch({ type: 'toggleMaximizeLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);

    return (
        <SplitCanvasLeafFrame
            leafId={props.leaf.id}
            accessibilityLabel={props.renderLeafLabel?.(props.leaf)}
            isFocused={props.isFocused}
            isMaximized={props.isMaximized}
            quietChrome={!props.hasMultipleLeaves}
            showControls={props.hasMultipleLeaves && (props.isFocused || props.isMaximized)}
            showFocusRing={props.hasMultipleLeaves && props.isFocused}
            keyboardFocusVisible={props.hasMultipleLeaves && props.isFocused && props.inputModality === 'keyboard'}
            onLayout={handleLayout}
            onHostRefChange={handleHostRefChange}
            onFocus={handleFocus}
            onClose={handleClose}
            onToggleMaximize={handleToggleMaximize}
        >
            <View style={leafContentContainerStyle}>
                {props.renderLeaf({
                    leaf: props.leaf,
                    isFocused: props.isFocused,
                    isMaximized: props.isMaximized,
                })}
                <SplitCanvasDropOverlay target={props.target} />
            </View>
        </SplitCanvasLeafFrame>
    );
}

const SplitCanvasLeafRenderer = React.memo(
    SplitCanvasLeafRendererInner,
) as typeof SplitCanvasLeafRendererInner;

const SplitCanvasRetainedBranch = React.memo(<TLeafPayload,>(props: Readonly<{
    node: SplitCanvasNode<TLeafPayload>;
    isActive: boolean;
    mode: 'flow';
    testID: string;
    containerStyle: Readonly<{
        flex: number;
        minWidth: 0;
        minHeight: 0;
    }>;
    renderNode: (node: SplitCanvasNode<TLeafPayload>) => React.ReactNode;
}>) => {
    const lastRenderedNodeRef = React.useRef(props.node);
    const renderedSubtreeRef = React.useRef<React.ReactNode>(props.renderNode(props.node));

    if (props.isActive || lastRenderedNodeRef.current !== props.node) {
        renderedSubtreeRef.current = props.renderNode(props.node);
        lastRenderedNodeRef.current = props.node;
    }

    return (
        <RetainedPanelSurface isActive={props.isActive} mode={props.mode}>
            <View testID={props.testID} style={props.containerStyle}>
                {renderedSubtreeRef.current}
            </View>
        </RetainedPanelSurface>
    );
}) as <TLeafPayload>(props: Readonly<{
    node: SplitCanvasNode<TLeafPayload>;
    isActive: boolean;
    mode: 'flow';
    testID: string;
    containerStyle: Readonly<{
        flex: number;
        minWidth: 0;
        minHeight: 0;
    }>;
    renderNode: (node: SplitCanvasNode<TLeafPayload>) => React.ReactNode;
}>) => React.ReactElement;

function SplitNodeRenderer<TLeafPayload>(props: Readonly<{
    node: Extract<SplitCanvasNode<TLeafPayload>, { kind: 'split' }>;
    maximizedLeafId: string | null;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    renderNode: (node: SplitCanvasNode<TLeafPayload>) => React.ReactNode;
}>) {
    const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
    const [dragRatio, setDragRatio] = React.useState<number | null>(null);
    const pendingDragRatioRef = React.useRef<number | null>(null);
    const dragRatioFrameRef = React.useRef<number | null>(null);
    const firstVisible = !props.maximizedLeafId || splitCanvasSubtreeContainsLeaf(props.node.first, props.maximizedLeafId);
    const secondVisible = !props.maximizedLeafId || splitCanvasSubtreeContainsLeaf(props.node.second, props.maximizedLeafId);
    const effectiveRatio = roundRatio(dragRatio ?? props.node.ratio);
    const inverseRatio = roundRatio(1 - effectiveRatio);

    const containerAxisSizePx = props.node.axis === 'row'
        ? containerSize.width
        : containerSize.height;

    const handleLayout = React.useCallback((event: any) => {
        const width = event?.nativeEvent?.layout?.width;
        const height = event?.nativeEvent?.layout?.height;
        const nextWidth = typeof width === 'number' ? width : 0;
        const nextHeight = typeof height === 'number' ? height : 0;
        setContainerSize((current) => {
            if (current.width === nextWidth && current.height === nextHeight) {
                return current;
            }
            return {
                width: nextWidth,
                height: nextHeight,
            };
        });
    }, []);

    const cancelDragRatioFrame = React.useCallback(() => {
        const frame = dragRatioFrameRef.current;
        if (frame != null && typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(frame);
        }
        dragRatioFrameRef.current = null;
    }, []);

    const flushPendingDragRatio = React.useCallback(() => {
        dragRatioFrameRef.current = null;
        const nextRatio = pendingDragRatioRef.current;
        setDragRatio((current) => (current === nextRatio ? current : nextRatio));
    }, []);

    const handleDragRatio = React.useCallback((ratio: number | null) => {
        pendingDragRatioRef.current = ratio;

        if (ratio == null) {
            cancelDragRatioFrame();
            setDragRatio((current) => (current === null ? current : null));
            return;
        }

        if (typeof globalThis.requestAnimationFrame !== 'function') {
            setDragRatio((current) => (current === ratio ? current : ratio));
            return;
        }

        if (dragRatioFrameRef.current != null) {
            return;
        }

        dragRatioFrameRef.current = globalThis.requestAnimationFrame(flushPendingDragRatio);
    }, [cancelDragRatioFrame, flushPendingDragRatio]);

    const handleCommitRatio = React.useCallback((ratio: number) => {
        pendingDragRatioRef.current = null;
        cancelDragRatioFrame();
        setDragRatio(null);
        props.dispatch({
            type: 'setSplitRatio',
            splitId: props.node.id,
            ratio,
        });
    }, [cancelDragRatioFrame, props.dispatch, props.node.id]);

    React.useEffect(() => cancelDragRatioFrame, [cancelDragRatioFrame]);

    return (
        <View
            testID={`split-canvas-split-${props.node.id}`}
            onLayout={handleLayout}
            style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                flexDirection: resolveFlexDirection(props.node.axis),
            }}
        >
            <SplitCanvasRetainedBranch
                node={props.node.first}
                isActive={firstVisible}
                mode="flow"
                testID={`split-canvas-pane-first-${props.node.id}`}
                containerStyle={{ flex: effectiveRatio, minWidth: 0, minHeight: 0 }}
                renderNode={props.renderNode}
            />

            {firstVisible && secondVisible ? (
                <SplitCanvasDivider
                    splitId={props.node.id}
                    axis={props.node.axis}
                    containerSizePx={containerAxisSizePx}
                    ratio={props.node.ratio}
                    minRatio={0.2}
                    maxRatio={0.8}
                    onDragRatio={handleDragRatio}
                    onCommitRatio={handleCommitRatio}
                />
            ) : null}

            <SplitCanvasRetainedBranch
                node={props.node.second}
                isActive={secondVisible}
                mode="flow"
                testID={`split-canvas-pane-second-${props.node.id}`}
                containerStyle={{ flex: inverseRatio, minWidth: 0, minHeight: 0 }}
                renderNode={props.renderNode}
            />
        </View>
    );
}
