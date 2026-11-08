import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { useEntityDropTargetState } from '@/components/ui/treeDragDrop';
import { SplitCanvasDivider, SPLIT_CANVAS_DIVIDER_SIZE_PX } from './SplitCanvasDivider';
import { SplitCanvasDropOverlay } from './SplitCanvasDropOverlay';
import { SplitCanvasLeafFrame } from './SplitCanvasLeafFrame';
import { useSplitCanvasDnD, splitCanvasEntityTargetId, type SplitCanvasEntityDrop } from '../hooks/useSplitCanvasDnD';
import { SplitCanvasInputModalityProvider } from '../hooks/useSplitCanvasInputModality';
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
import { collectSplitCanvasLeafRects, countSplitCanvasLeaves, findSplitCanvasLeaf, splitCanvasSubtreeContainsLeaf } from '../model/splitCanvasTree';

function resolveFlexDirection(axis: SplitCanvasAxis): 'row' | 'column' {
    return axis === 'row' ? 'row' : 'column';
}

function roundRatio(value: number): number {
    return Number(value.toFixed(4));
}

type MinimumSize = Readonly<{ width: number; height: number }>;
type LeafEdges = Readonly<{ left: boolean; right: boolean; top: boolean; bottom: boolean }>;
const ALL_EDGES: LeafEdges = { left: true, right: true, top: true, bottom: true };
type LeafRect = Readonly<{ x: number; y: number; width: number; height: number }>;
/** A maximized leaf's layer: the whole host, from its origin. */
const HOST_ORIGIN_RECT: LeafRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * The absolute frame of a layer over one leaf, offset by `inset` (its measured header). A side on the
 * host's edge is held by the host, not by the rect: the rect comes from the host size measured after
 * paint, so it lags a window resize, and a width drawn from it would keep the previous window's layout
 * (a single phone-width leaf drawn 1060 px wide) until the next measurement lands.
 */
function leafLayerFrame(rect: LeafRect, edges: LeafEdges, inset: Readonly<{ x: number; y: number }> = { x: 0, y: 0 }) {
    return {
        position: 'absolute' as const,
        left: rect.x + inset.x,
        top: rect.y + inset.y,
        ...(edges.right ? { right: 0 } : { width: Math.max(0, rect.width - inset.x) }),
        ...(edges.bottom ? { bottom: 0 } : { height: Math.max(0, rect.height - inset.y) }),
        minWidth: 0,
        minHeight: 0,
    };
}

type DividerSizes = Readonly<Record<SplitCanvasAxis, number>>;
export type SplitCanvasRetainedLeafContentContext = Readonly<{
    leafId: string;
    isFocused: boolean;
    isVisible: boolean;
    touchesLeftEdge: boolean;
    touchesRightEdge: boolean;
}>;
export type SplitCanvasRetainedLeafContent = Readonly<{
    id: string;
    leafId: string;
    isActive: boolean;
    render: (context: SplitCanvasRetainedLeafContentContext) => React.ReactNode;
}>;
type RenderLeaf<TLeafPayload> = (input: Readonly<{
    leaf: SplitCanvasLeafNode<TLeafPayload>;
    isFocused: boolean;
    isMaximized: boolean;
    touchesLeftEdge: boolean;
    touchesRightEdge: boolean;
    requestSplit: (direction: SplitCanvasDirection) => void;
}>) => React.ReactNode;
type SplitCanvasContentProps<TLeafPayload> =
    | Readonly<{ renderLeaf: RenderLeaf<TLeafPayload>; renderLeafHeader?: undefined; retainedLeafContents?: undefined }>
    | Readonly<{ renderLeaf?: undefined; renderLeafHeader: RenderLeaf<TLeafPayload>; retainedLeafContents: readonly SplitCanvasRetainedLeafContent[] }>;
export type SplitCanvasHostControls = Readonly<{
    readSplitMeasurement: (leafId: string, direction: SplitCanvasDirection) => Readonly<{ availableSizePx: number; minimumExistingSizePx: number }> | null;
    resizeSplit: (splitId: string, ratio: number) => boolean;
}>;

function subtreeMinimumSize<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload>,
    getLeafMinimumSizePx: (leaf: SplitCanvasLeafNode<TLeafPayload>) => MinimumSize,
    dividerSizePx: DividerSizes,
): MinimumSize {
    if (node.kind === 'leaf') return getLeafMinimumSizePx(node);
    const first = subtreeMinimumSize(node.first, getLeafMinimumSizePx, dividerSizePx);
    const second = subtreeMinimumSize(node.second, getLeafMinimumSizePx, dividerSizePx);
    return node.axis === 'row'
        ? { width: first.width + second.width + dividerSizePx.row, height: Math.max(first.height, second.height) }
        : { width: Math.max(first.width, second.width), height: first.height + second.height + dividerSizePx.column };
}

function splitNodeSizing<TLeafPayload>(
    node: Extract<SplitCanvasNode<TLeafPayload>, { kind: 'split' }>,
    size: MinimumSize,
    getLeafMinimumSizePx?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => MinimumSize,
    dividerSizePx: DividerSizes = SPLIT_CANVAS_DIVIDER_SIZE_PX,
) {
    const containerAxisSizePx = node.axis === 'row' ? size.width : size.height;
    const availableSizePx = Math.max(0, containerAxisSizePx - dividerSizePx[node.axis]);
    const firstMinimum = getLeafMinimumSizePx ? subtreeMinimumSize(node.first, getLeafMinimumSizePx, dividerSizePx) : null;
    const secondMinimum = getLeafMinimumSizePx ? subtreeMinimumSize(node.second, getLeafMinimumSizePx, dividerSizePx) : null;
    const minimumFirstSizePx = firstMinimum ? (node.axis === 'row' ? firstMinimum.width : firstMinimum.height) : 0;
    const minimumSecondSizePx = secondMinimum ? (node.axis === 'row' ? secondMinimum.width : secondMinimum.height) : 0;
    const hasMeasuredMinimums = firstMinimum !== null && secondMinimum !== null && availableSizePx > 0;
    const minimumsFit = hasMeasuredMinimums && minimumFirstSizePx + minimumSecondSizePx <= availableSizePx;
    return {
        containerAxisSizePx, availableSizePx, minimumFirstSizePx, minimumSecondSizePx, hasMeasuredMinimums,
        minRatio: minimumsFit ? minimumFirstSizePx / availableSizePx : 0.2,
        maxRatio: minimumsFit ? 1 - minimumSecondSizePx / availableSizePx : 0.8,
    };
}

function resolveSplitRatio(ratio: number, bounds: Readonly<{ minRatio: number; maxRatio: number }>): number {
    return roundRatio(Math.min(bounds.maxRatio, Math.max(bounds.minRatio, ratio)));
}

const hostRootStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
} as const;

const leafContentContainerStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
} as const;

function SplitCanvasHostInner<TLeafPayload>(props: Readonly<{
    state: SplitCanvasState<TLeafPayload>;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => string;
    getLeafMinimumSizePx?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => MinimumSize;
    onRequestSplitLeaf?: (input: Readonly<{
        leafId: string;
        direction: SplitCanvasDirection;
        availableSizePx?: number;
        minimumExistingSizePx?: number;
    }>) => void;
    entityDrop?: SplitCanvasEntityDrop;
    keyboardEnabled?: boolean;
    controlsRef?: React.MutableRefObject<SplitCanvasHostControls | null>;
    /**
     * `framed` (default): each pane is a card with its own maximize/close controls and a focus ring.
     * `flat`: the panes carry no chrome of their own — the consumer shows focus and pane actions
     * elsewhere (the workspace: the raised tab and the tab menu); only a keyboard focus change still
     * rings the pane.
     */
    chrome?: 'framed' | 'flat';
    /** Inset consumers use the same gutter for rendered dividers, pane rectangles and admission. */
    gutterSizePx?: number;
}> & SplitCanvasContentProps<TLeafPayload>) {
    const dividerSizePx = React.useMemo<DividerSizes>(() => props.gutterSizePx === undefined
        ? SPLIT_CANVAS_DIVIDER_SIZE_PX : { row: props.gutterSizePx, column: props.gutterSizePx }, [props.gutterSizePx]);
    const keyboardEnabled = props.keyboardEnabled ?? true;
    const leafCount = countSplitCanvasLeaves(props.state.root);
    const hasMultipleLeaves = leafCount > 1;
    const leafSizesRef = React.useRef<Map<string, MinimumSize>>(new Map());
    const hostSizeRef = React.useRef<MinimumSize | null>(null);
    const [hostSize, setHostSize] = React.useState<MinimumSize | null>(null);
    const [contentSlots, setContentSlots] = React.useState<Readonly<Record<string, Readonly<{ x: number; y: number }>>>>({});
    React.useEffect(() => {
        setContentSlots(current => {
            const removed = Object.keys(current).filter(leafId => !findSplitCanvasLeaf(props.state.root, leafId));
            if (removed.length === 0) return current;
            const next = { ...current };
            for (const leafId of removed) delete next[leafId];
            return next;
        });
    }, [props.state.root]);
    const handleContentSlotLayout = React.useCallback((leafId: string, event: LayoutChangeEvent) => {
        const { x, y } = event.nativeEvent.layout;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        setContentSlots(current => current[leafId]?.x === x && current[leafId]?.y === y ? current : { ...current, [leafId]: { x, y } });
    }, []);
    const renderLeaf = props.retainedLeafContents === undefined ? props.renderLeaf : props.renderLeafHeader;
    const [liveRatios, setLiveRatios] = React.useState<Readonly<Record<string, number>>>({});
    const publishLiveRatio = React.useCallback((splitId: string, ratio: number | null) => {
        setLiveRatios(current => {
            if (ratio === null) {
                if (!(splitId in current)) return current;
                const next = { ...current };
                delete next[splitId];
                return next;
            }
            return current[splitId] === ratio ? current : { ...current, [splitId]: ratio };
        });
    }, []);
    const resizeHandlers = React.useRef(new Map<string, (ratio: number) => boolean>());
    const registerResize = React.useCallback((splitId: string, resize: (ratio: number) => boolean) => {
        resizeHandlers.current.set(splitId, resize);
        return () => { if (resizeHandlers.current.get(splitId) === resize) resizeHandlers.current.delete(splitId); };
    }, []);
    const readSplitMeasurement = React.useCallback((leafId: string, direction: SplitCanvasDirection) => {
        if (!props.getLeafMinimumSizePx) return null;
        let size: MinimumSize | undefined = leafSizesRef.current.get(leafId);
        const hostSize = hostSizeRef.current;
        if (hostSize) {
            // Admission uses the current normal tree, including immediately after maximize or a split.
            size = collectSplitCanvasLeafRects(props.state.root, { x: 0, y: 0, ...hostSize }, {
                dividerSizePx,
                resolveRatio: (node, nodeSize) => resolveSplitRatio(node.ratio, splitNodeSizing(node, nodeSize, props.getLeafMinimumSizePx, dividerSizePx)),
            }).find((rect) => rect.leafId === leafId);
        } else if (props.state.maximizedLeafId) {
            return null;
        }
        const leaf = findSplitCanvasLeaf(props.state.root, leafId);
        if (!size || !leaf) return null;
        const axis = direction === 'left' || direction === 'right' ? 'row' : 'column';
        const extent = axis === 'row' ? size.width : size.height;
        const minimum = props.getLeafMinimumSizePx(leaf);
        const minimumExistingSizePx = axis === 'row' ? minimum.width : minimum.height;
        const availableSizePx = extent - dividerSizePx[axis];
        if (!Number.isFinite(availableSizePx) || availableSizePx <= 0
            || !Number.isFinite(minimumExistingSizePx) || minimumExistingSizePx < 0) return null;
        return { availableSizePx, minimumExistingSizePx };
    }, [dividerSizePx, props.getLeafMinimumSizePx, props.state.maximizedLeafId, props.state.root]);
    React.useLayoutEffect(() => {
        if (!props.controlsRef) return;
        const controls: SplitCanvasHostControls = {
            readSplitMeasurement,
            resizeSplit: (splitId, ratio) => resizeHandlers.current.get(splitId)?.(ratio) ?? false,
        };
        props.controlsRef.current = controls;
        return () => { if (props.controlsRef?.current === controls) props.controlsRef.current = null; };
    }, [props.controlsRef, readSplitMeasurement]);
    const handleSplitRequest = React.useCallback((leafId: string, direction: SplitCanvasDirection) => {
        const measurement = readSplitMeasurement(leafId, direction);
        props.onRequestSplitLeaf?.({ leafId, direction, ...(measurement ?? {}) });
    }, [props.onRequestSplitLeaf, readSplitMeasurement]);

    useSplitCanvasKeyboard({
        enabled: keyboardEnabled,
        state: props.state,
        dispatch: props.dispatch,
        onSplit: props.onRequestSplitLeaf ? handleSplitRequest : undefined,
    });

    // An edge is offered only where the pane can really split: the pane keeps its minimum and the
    // new pane gets one too (every pane here sizes by the same leaf minimum). Below that the whole
    // pane is the centre (lab C2s "Too narrow to split").
    const isSplitOffered = React.useCallback((leafId: string, direction: SplitCanvasDirection) => {
        const leaf = findSplitCanvasLeaf(props.state.root, leafId);
        if (!leaf) return false;
        if (!props.getLeafMinimumSizePx) return true;
        const measurement = readSplitMeasurement(leafId, direction);
        if (!measurement) return false;
        const minimum = props.getLeafMinimumSizePx(leaf);
        const minimumNewSizePx = direction === 'left' || direction === 'right' ? minimum.width : minimum.height;
        return measurement.minimumExistingSizePx + minimumNewSizePx <= measurement.availableSizePx;
    }, [props.getLeafMinimumSizePx, props.state.root, readSplitMeasurement]);
    const splitCanvasDnD = useSplitCanvasDnD({
        entityDrop: props.entityDrop,
        isLeafCurrent: leafId => Boolean(findSplitCanvasLeaf(props.state.root, leafId))
            && (!props.state.maximizedLeafId || props.state.maximizedLeafId === leafId),
        readSplitMeasurement,
        isSplitOffered,
    });
    const hostDropRef = useEntityDropDomBinding(props.entityDrop?.runtime);

    const handleLeafLayout = React.useCallback((leafId: string, event: LayoutChangeEvent) => {
        splitCanvasDnD.onLeafLayout(leafId, event);
        const width = event?.nativeEvent?.layout?.width;
        const height = event?.nativeEvent?.layout?.height;
        if (typeof width === 'number' && Number.isFinite(width) && width > 0
            && typeof height === 'number' && Number.isFinite(height) && height > 0) {
            leafSizesRef.current.set(leafId, { width, height });
        } else {
            leafSizesRef.current.delete(leafId);
        }
    }, [splitCanvasDnD.onLeafLayout]);

    const handleHostLayout = React.useCallback((event: LayoutChangeEvent) => {
        splitCanvasDnD.onHostLayout(event);
        const { width, height } = event.nativeEvent.layout;
        hostSizeRef.current = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
            ? { width, height } : null;
        const size = hostSizeRef.current;
        setHostSize(current => current?.width === size?.width && current?.height === size?.height ? current : size);
    }, [splitCanvasDnD.onHostLayout]);

    const registerLeafHost = React.useCallback((leafId: string, host: SplitCanvasLeafHostRef | null) => {
        splitCanvasDnD.registerLeafHost(leafId, host);
        if (!host) leafSizesRef.current.delete(leafId);
    }, [splitCanvasDnD.registerLeafHost]);

    // Edge contact follows the existing split topology, independent of pane size and live ratios.
    const leafEdges = React.useMemo(() => {
        const edges = new Map<string, LeafEdges>();
        function visit(node: SplitCanvasNode<TLeafPayload>, at: LeafEdges): void {
            if (node.kind === 'leaf') {
                edges.set(node.id, at);
                return;
            }
            const stacked = node.axis === 'column';
            visit(node.first, { ...at, right: stacked && at.right, bottom: !stacked && at.bottom });
            visit(node.second, { ...at, left: stacked && at.left, top: !stacked && at.top });
        }
        if (props.state.root) visit(props.state.root, ALL_EDGES);
        return edges;
    }, [props.state.root]);

    const renderLeafNode = React.useCallback((node: SplitCanvasLeafNode<TLeafPayload>): React.ReactNode => {
            const isFocused = props.state.focusedLeafId === node.id;
            const isMaximized = props.state.maximizedLeafId === node.id;
            const edges = leafEdges.get(node.id);
            return (
                <SplitCanvasLeafRenderer
                    key={node.id}
                    leaf={node}
                    isFocused={isFocused}
                    isMaximized={isMaximized}
                    touchesLeftEdge={isMaximized || edges?.left === true}
                    touchesRightEdge={isMaximized || edges?.right === true}
                    hasMultipleLeaves={hasMultipleLeaves}
                    flatChrome={props.chrome === 'flat'}
                    dispatch={props.dispatch}
                    renderLeaf={renderLeaf}
                    retainedContent={props.retainedLeafContents !== undefined}
                    onContentSlotLayout={handleContentSlotLayout}
                    renderLeafLabel={props.renderLeafLabel}
                    onLeafLayout={handleLeafLayout}
                    registerLeafHost={registerLeafHost}
                    onRequestSplit={handleSplitRequest}
                />
            );
    }, [
        hasMultipleLeaves, leafEdges, props.chrome, props.dispatch,
        renderLeaf, props.retainedLeafContents, props.renderLeafLabel, props.state.focusedLeafId, props.state.maximizedLeafId,
        handleLeafLayout, registerLeafHost, handleSplitRequest, handleContentSlotLayout,
    ]);

    const renderNode = React.useCallback((node: SplitCanvasNode<TLeafPayload>): React.ReactNode => {
        if (node.kind === 'leaf') return <View style={{ flex: 1, minWidth: 0, minHeight: 0 }} />;
        return (
            <SplitNodeRenderer
                key={node.id}
                node={node}
                maximizedLeafId={props.state.maximizedLeafId}
                dispatch={props.dispatch}
                renderNode={renderNode}
                getLeafMinimumSizePx={props.getLeafMinimumSizePx}
                registerResize={registerResize}
                publishLiveRatio={publishLiveRatio}
                dividerSizePx={dividerSizePx}
            />
        );
    }, [
        hasMultipleLeaves,
        props.chrome,
        props.entityDrop,
        props.dispatch,
        props.getLeafMinimumSizePx,
        renderLeaf,
        props.renderLeafLabel,
        props.state.focusedLeafId,
        props.state.maximizedLeafId,
        handleLeafLayout,
        registerLeafHost,
        handleSplitRequest,
        registerResize,
        publishLiveRatio,
        dividerSizePx,
    ]);

    if (!props.state.root) return null;
    const leafRects = collectSplitCanvasLeafRects(props.state.root, { x: 0, y: 0, width: hostSize?.width ?? 0, height: hostSize?.height ?? 0 }, {
        dividerSizePx,
        resolveRatio: (node, size) => resolveSplitRatio(liveRatios[node.id] ?? node.ratio, splitNodeSizing(node, size, props.getLeafMinimumSizePx, dividerSizePx)),
    });

    return (
        <SplitCanvasInputModalityProvider enabled={keyboardEnabled}><View
            ref={hostDropRef}
            testID="split-canvas-host"
            onLayout={handleHostLayout}
            style={hostRootStyle}
        >
            {renderNode(props.state.root)}
            <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
                {leafRects.map(rect => {
                    const leaf = findSplitCanvasLeaf(props.state.root, rect.leafId);
                    if (!leaf) return null;
                    const visible = !props.state.maximizedLeafId || props.state.maximizedLeafId === leaf.id;
                    const maximized = props.state.maximizedLeafId === leaf.id;
                    return <View key={leaf.id} pointerEvents={visible ? 'auto' : 'none'} style={maximized
                        ? leafLayerFrame(HOST_ORIGIN_RECT, ALL_EDGES)
                        : leafLayerFrame(rect, leafEdges.get(leaf.id) ?? ALL_EDGES)}>
                        <RetainedPanelSurface isActive={visible} mode="flow" suspendWhenHidden>{renderLeafNode(leaf)}</RetainedPanelSurface>
                    </View>;
                })}
                {props.retainedLeafContents?.map(member => {
                    const rect = leafRects.find(candidate => candidate.leafId === member.leafId);
                    if (!rect) return null;
                    const maximized = props.state.maximizedLeafId === member.leafId;
                    const edges = leafEdges.get(member.leafId);
                    const slot = contentSlots[member.leafId];
                    const visible = Boolean(slot) && member.isActive && (!props.state.maximizedLeafId || maximized);
                    // The shared frame has no content padding: the measured slot captures its header inset.
                    const x = slot?.x ?? 0;
                    const y = slot?.y ?? 0;
                    return <View key={member.id} testID={`split-canvas-retained-content-${member.id}`}
                        pointerEvents={visible ? 'auto' : 'none'} style={[maximized
                            ? leafLayerFrame(HOST_ORIGIN_RECT, ALL_EDGES, { x, y })
                            : leafLayerFrame(rect, edges ?? ALL_EDGES, { x, y }), { overflow: 'hidden' }]}>
                        <RetainedPanelSurface isActive={visible} mode="flow" suspendWhenHidden>
                            <SplitCanvasRetainedMemberRenderer id={member.id} leafId={member.leafId}
                                isFocused={props.state.focusedLeafId === member.leafId} isVisible={visible}
                                touchesLeftEdge={maximized || edges?.left === true}
                                touchesRightEdge={maximized || edges?.right === true}
                                render={member.render} dispatch={props.dispatch} />
                        </RetainedPanelSurface>
                    </View>;
                })}
                {props.entityDrop ? leafRects.map(rect => {
                    if (props.state.maximizedLeafId && props.state.maximizedLeafId !== rect.leafId) return null;
                    const maximized = props.state.maximizedLeafId === rect.leafId;
                    return <View key={`drop:${rect.leafId}`} pointerEvents="none" style={maximized
                        ? leafLayerFrame(HOST_ORIGIN_RECT, ALL_EDGES)
                        : leafLayerFrame(rect, leafEdges.get(rect.leafId) ?? ALL_EDGES)}>
                        <SplitCanvasEntityDropFeedback entityDrop={props.entityDrop!}
                            leafId={rect.leafId} isSplitOffered={isSplitOffered} />
                    </View>;
                }) : null}
            </View>
        </View></SplitCanvasInputModalityProvider>
    );
}

export const SplitCanvasHost = React.memo(SplitCanvasHostInner) as typeof SplitCanvasHostInner;

function SplitCanvasRetainedMemberRendererInner<TLeafPayload>(props: Readonly<{
    id: string;
    leafId: string;
    isFocused: boolean;
    isVisible: boolean;
    touchesLeftEdge: boolean;
    touchesRightEdge: boolean;
    render: SplitCanvasRetainedLeafContent['render'];
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
}>) {
    const focus = React.useCallback(() => {
        if (props.isVisible) props.dispatch({ type: 'focusLeaf', leafId: props.leafId });
    }, [props.dispatch, props.isVisible, props.leafId]);
    return <SplitCanvasLeafFrame leafId={`member:${props.id}`} isFocused={props.isFocused} isMaximized={false}
        quietChrome showControls={false} showFocusRing={false} onFocus={focus}
        onClose={() => {}} onToggleMaximize={() => {}}>
        {props.render({ leafId: props.leafId, isFocused: props.isFocused, isVisible: props.isVisible,
            touchesLeftEdge: props.touchesLeftEdge, touchesRightEdge: props.touchesRightEdge })}
    </SplitCanvasLeafFrame>;
}
const SplitCanvasRetainedMemberRenderer = React.memo(SplitCanvasRetainedMemberRendererInner) as typeof SplitCanvasRetainedMemberRendererInner;

function SplitCanvasLeafRendererInner<TLeafPayload>(props: Readonly<{
    leaf: SplitCanvasLeafNode<TLeafPayload>;
    isFocused: boolean;
    isMaximized: boolean;
    touchesLeftEdge: boolean;
    touchesRightEdge: boolean;
    hasMultipleLeaves: boolean;
    flatChrome: boolean;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    renderLeaf: RenderLeaf<TLeafPayload>;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => string;
    retainedContent: boolean;
    onContentSlotLayout: (leafId: string, event: LayoutChangeEvent) => void;
    onLeafLayout: (leafId: string, event: LayoutChangeEvent) => void;
    registerLeafHost: (leafId: string, host: SplitCanvasLeafHostRef | null) => void;
    onRequestSplit: (leafId: string, direction: SplitCanvasDirection) => void;
}>) {
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        props.onLeafLayout(props.leaf.id, event);
    }, [props.leaf.id, props.onLeafLayout]);

    const handleHostRefChange = React.useCallback((host: SplitCanvasLeafHostRef | null) => {
        props.registerLeafHost(props.leaf.id, host);
    }, [props.leaf.id, props.registerLeafHost]);

    const handleFocus = React.useCallback(() => {
        props.dispatch({ type: 'focusLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);

    const requestSplit = React.useCallback((direction: SplitCanvasDirection) => {
        props.onRequestSplit(props.leaf.id, direction);
    }, [props.onRequestSplit, props.leaf.id]);

    const handleClose = React.useCallback(() => {
        props.dispatch({ type: 'closeLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);

    const handleToggleMaximize = React.useCallback(() => {
        props.dispatch({ type: 'toggleMaximizeLeaf', leafId: props.leaf.id });
    }, [props.dispatch, props.leaf.id]);
    const content = props.renderLeaf({ leaf: props.leaf, isFocused: props.isFocused, isMaximized: props.isMaximized,
        touchesLeftEdge: props.touchesLeftEdge, touchesRightEdge: props.touchesRightEdge, requestSplit });

    return (
        <SplitCanvasLeafFrame
            leafId={props.leaf.id}
            accessibilityLabel={props.renderLeafLabel?.(props.leaf)}
            isFocused={props.isFocused}
            isMaximized={props.isMaximized}
            quietChrome={props.flatChrome || !props.hasMultipleLeaves}
            showControls={!props.flatChrome && props.hasMultipleLeaves && (props.isFocused || props.isMaximized)}
            showFocusRing={props.hasMultipleLeaves && props.isFocused}
            focusRingKeyboardOnly={props.flatChrome}
            onLayout={handleLayout}
            onHostRefChange={handleHostRefChange}
            onFocus={handleFocus}
            onClose={handleClose}
            onToggleMaximize={handleToggleMaximize}
        >
            <View style={leafContentContainerStyle}>
                {props.retainedContent ? <View style={{ flexShrink: 0 }}>{content}</View> : content}
                {props.retainedContent ? <View pointerEvents="none" testID={`split-canvas-content-slot-${props.leaf.id}`}
                    style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                    onLayout={event => props.onContentSlotLayout(props.leaf.id, event)} /> : null}
            </View>
        </SplitCanvasLeafFrame>
    );
}

/** One pane's zone: the admitted place under the carry, if any. Refused places light nothing. */
function SplitCanvasEntityDropFeedback(props: Readonly<{
    entityDrop: SplitCanvasEntityDrop;
    leafId: string;
    isSplitOffered: (leafId: string, direction: SplitCanvasDirection) => boolean;
}>) {
    const { runtime, id } = props.entityDrop;
    const center = useEntityDropTargetState(runtime, splitCanvasEntityTargetId(id, props.leafId, 'center'));
    const left = useEntityDropTargetState(runtime, splitCanvasEntityTargetId(id, props.leafId, 'left'));
    const right = useEntityDropTargetState(runtime, splitCanvasEntityTargetId(id, props.leafId, 'right'));
    const up = useEntityDropTargetState(runtime, splitCanvasEntityTargetId(id, props.leafId, 'up'));
    const down = useEntityDropTargetState(runtime, splitCanvasEntityTargetId(id, props.leafId, 'down'));
    const admitted = (state: typeof center) => state?.admission?.status === 'allowed'
        && (state.phase === 'carrying' || state.phase === 'pending');
    const placement = admitted(center) ? 'center' : admitted(left) ? 'left' : admitted(right) ? 'right'
        : admitted(up) ? 'up' : admitted(down) ? 'down' : null;
    // Read when the verdict changes, not per pointer frame.
    const edgeMarks = placement === 'center'
        ? SPLIT_CANVAS_EDGE_DIRECTIONS.filter(direction => props.isSplitOffered(props.leafId, direction)) : undefined;
    return <SplitCanvasDropOverlay target={placement ? { leafId: props.leafId, placement } : null} edgeMarks={edgeMarks} />;
}
const SPLIT_CANVAS_EDGE_DIRECTIONS: readonly SplitCanvasDirection[] = ['left', 'right', 'up', 'down'];

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
    const lastRendererRef = React.useRef(props.renderNode);
    const renderedSubtreeRef = React.useRef<React.ReactNode>(props.renderNode(props.node));

    if (props.isActive || lastRenderedNodeRef.current !== props.node || lastRendererRef.current !== props.renderNode) {
        renderedSubtreeRef.current = props.renderNode(props.node);
        lastRenderedNodeRef.current = props.node;
        lastRendererRef.current = props.renderNode;
    }

    return (
        <RetainedPanelSurface isActive={props.isActive} mode={props.mode} suspendWhenHidden>
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
    getLeafMinimumSizePx?: (leaf: SplitCanvasLeafNode<TLeafPayload>) => MinimumSize;
    registerResize: (splitId: string, resize: (ratio: number) => boolean) => () => void;
    publishLiveRatio: (splitId: string, ratio: number | null) => void;
    dividerSizePx: DividerSizes;
}>) {
    const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
    const [dragRatio, setDragRatio] = React.useState<number | null>(null);
    const firstVisible = !props.maximizedLeafId || splitCanvasSubtreeContainsLeaf(props.node.first, props.maximizedLeafId);
    const secondVisible = !props.maximizedLeafId || splitCanvasSubtreeContainsLeaf(props.node.second, props.maximizedLeafId);
    const {
        containerAxisSizePx, availableSizePx, minimumFirstSizePx, minimumSecondSizePx, hasMeasuredMinimums, minRatio, maxRatio,
    } = splitNodeSizing(props.node, containerSize, props.getLeafMinimumSizePx, props.dividerSizePx);
    const effectiveRatio = resolveSplitRatio(dragRatio ?? props.node.ratio, { minRatio, maxRatio });
    const inverseRatio = roundRatio(1 - effectiveRatio);
    React.useLayoutEffect(() => {
        props.publishLiveRatio(props.node.id, dragRatio === null ? null : effectiveRatio);
        return () => props.publishLiveRatio(props.node.id, null);
    }, [dragRatio, effectiveRatio, props.node.id, props.publishLiveRatio]);

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

    const handleDragRatio = React.useCallback((ratio: number | null) => {
        // The shared resize owner already publishes once per animation frame.
        setDragRatio(current => current === ratio ? current : ratio);
    }, []);

    const handleCommitRatio = React.useCallback((ratio: number) => {
        setDragRatio(null);
        props.dispatch({
            type: 'setSplitRatio',
            splitId: props.node.id,
            ratio,
            ...(hasMeasuredMinimums ? { availableSizePx, minimumFirstSizePx, minimumSecondSizePx } : {}),
        });
    }, [availableSizePx, hasMeasuredMinimums, minimumFirstSizePx, minimumSecondSizePx, props.dispatch, props.node.id]);
    React.useLayoutEffect(() => props.registerResize(props.node.id, (ratio) => {
        if (props.maximizedLeafId || !hasMeasuredMinimums || minimumFirstSizePx + minimumSecondSizePx > availableSizePx) return false;
        handleCommitRatio(ratio);
        return true;
    }), [availableSizePx, handleCommitRatio, hasMeasuredMinimums, minimumFirstSizePx, minimumSecondSizePx, props.maximizedLeafId, props.node.id, props.registerResize]);


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
                    gutterSizePx={props.dividerSizePx[props.node.axis]}
                    splitId={props.node.id}
                    axis={props.node.axis}
                    containerSizePx={containerAxisSizePx}
                    ratio={effectiveRatio}
                    minRatio={minRatio}
                    maxRatio={maxRatio}
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
