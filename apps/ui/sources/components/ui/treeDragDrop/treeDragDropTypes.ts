export type WindowBounds = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type WindowPointer = Readonly<{
    x: number;
    y: number;
}>;

export type TreeContainerScope = Readonly<{
    id: string;
    parentId: string | null;
    depth: number;
}>;

export type TreeContainerDropZoneRole =
    | 'container-body'
    | 'root-before-first'
    | 'root-after-last'
    | 'root-empty';

export type TreeContainerDropZone = Readonly<{
    containerId: string;
    rootId: string;
    parentId: string | null;
    depth: number;
    bounds: WindowBounds;
    role: TreeContainerDropZoneRole;
}>;

export type TreeRowKind = 'container' | 'leaf';

export type TreeRow = Readonly<{
    id: string;
    parentId: string | null;
    containerId: string;
    depth: number;
    kind: TreeRowKind;
    bounds: WindowBounds;
}>;

export type TreeDragSource = Readonly<{
    id: string;
    kind: TreeRowKind;
    excludedDescendantIds: ReadonlySet<string>;
}>;

export type TreeDropRules = Readonly<{
    canNestInto: (source: TreeDragSource, targetId: string) => boolean;
    canReorderAround: (source: TreeDragSource, target: TreeRow, parentId: string | null) => boolean;
    canMoveToRoot?: (source: TreeDragSource, dropZone: TreeContainerDropZone) => boolean;
    maxDepth?: number;
}>;

export type BlockedReason =
    | 'same-position'
    | 'descendant-cycle'
    | 'workspace-scope-mismatch'
    | 'leaf-cannot-be-parent'
    | 'max-depth-exceeded'
    | 'no-target';

export type TreeInstruction =
    | Readonly<{ kind: 'reorder-before'; targetId: string; containerId: string; parentId: string | null; depth: number }>
    | Readonly<{ kind: 'reorder-after'; targetId: string; containerId: string; parentId: string | null; depth: number }>
    | Readonly<{ kind: 'nest-into'; targetId: string; containerId: string; parentId: string; depth: number }>
    | Readonly<{ kind: 'move-to-root'; containerId: string; rootId: string; depth: number }>
    | Readonly<{ kind: 'blocked'; reason: BlockedReason; hintTargetId?: string }>
    | Readonly<{ kind: 'idle' }>;

export type TreeInstructionVisual =
    | Readonly<{ kind: 'line'; targetId: string; edge: 'top' | 'bottom'; depth: number }>
    | Readonly<{ kind: 'outline'; targetId: string }>
    | Readonly<{ kind: 'none' }>;

export type TreeDropResult = Readonly<{
    instruction: TreeInstruction;
    visual: TreeInstructionVisual;
}>;

export type ResolveTreeInstructionParams = Readonly<{
    rows: ReadonlyArray<TreeRow>;
    dropZones: ReadonlyArray<TreeContainerDropZone>;
    source: TreeDragSource;
    pointer: WindowPointer | null;
    rules: TreeDropRules;
}>;
