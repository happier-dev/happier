export type SplitCanvasAxis = 'row' | 'column';
export type SplitCanvasPlacement = 'before' | 'after';
export type SplitCanvasDirection = 'left' | 'right' | 'up' | 'down';

export type SplitCanvasLeafNode<TLeafPayload = unknown> = Readonly<{
    id: string;
    kind: 'leaf';
    leafKind: string;
    payload: TLeafPayload;
}>;

export type SplitCanvasSplitNode<TLeafPayload = unknown> = Readonly<{
    id: string;
    kind: 'split';
    axis: SplitCanvasAxis;
    ratio: number;
    first: SplitCanvasNode<TLeafPayload>;
    second: SplitCanvasNode<TLeafPayload>;
}>;

export type SplitCanvasNode<TLeafPayload = unknown> =
    | SplitCanvasLeafNode<TLeafPayload>
    | SplitCanvasSplitNode<TLeafPayload>;

export type SplitCanvasState<TLeafPayload = unknown> = Readonly<{
    root: SplitCanvasNode<TLeafPayload> | null;
    focusedLeafId: string | null;
    maximizedLeafId: string | null;
}>;

export type SplitCanvasAction<TLeafPayload = unknown> =
    | Readonly<{
        type: 'replaceRoot';
        root: SplitCanvasNode<TLeafPayload> | null;
        focusedLeafId?: string | null;
    }>
    | Readonly<{
        type: 'splitLeaf';
        targetLeafId: string;
        axis: SplitCanvasAxis;
        placement: SplitCanvasPlacement;
        newLeaf: SplitCanvasLeafNode<TLeafPayload>;
        /** Measured target extent along the split axis. All three fields travel together. */
        availableSizePx?: number;
        minimumFirstSizePx?: number;
        minimumSecondSizePx?: number;
    }>
    | Readonly<{
        type: 'replaceLeaf';
        leafId: string;
        nextLeaf: SplitCanvasLeafNode<TLeafPayload>;
    }>
    | Readonly<{
        type: 'moveLeaf';
        sourceLeafId: string;
        targetLeafId: string;
        placement: SplitCanvasPlacement;
    }>
    | Readonly<{
        type: 'closeLeaf';
        leafId: string;
    }>
    | Readonly<{
        type: 'focusLeaf';
        leafId: string | null;
    }>
    | Readonly<{
        type: 'toggleMaximizeLeaf';
        leafId: string;
    }>
    | Readonly<{
        type: 'restoreMaximize';
    }>
    | Readonly<{
        type: 'setSplitRatio';
        splitId: string;
        ratio: number;
        availableSizePx?: number;
        minimumFirstSizePx?: number;
        minimumSecondSizePx?: number;
    }>
    | Readonly<{
        type: 'rebalanceRatios';
    }>;

export type SplitCanvasLeafRect = Readonly<{
    leafId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type SplitCanvasLeafHostRef = Readonly<{
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    getBoundingClientRect?: () => Readonly<{
        left?: number;
        top?: number;
        width?: number;
        height?: number;
    }>;
}>;

export type SplitCanvasPersistenceSnapshot<TLeafPayload = unknown> = Readonly<{
    version: 1;
    root: SplitCanvasNode<TLeafPayload> | null;
    focusedLeafId: string | null;
    maximizedLeafId: string | null;
}>;

export type SplitCanvasDropTarget = Readonly<{
    leafId: string;
    placement: SplitCanvasDirection | 'center';
}>;
