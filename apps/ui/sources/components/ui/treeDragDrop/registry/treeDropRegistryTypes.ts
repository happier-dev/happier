import type { TreeContainerDropZone, TreeRow, WindowBounds } from '../treeDragDropTypes';

export type TreeDropRegistrySnapshot = Readonly<{
    rows: ReadonlyArray<TreeRow>;
    dropZones: ReadonlyArray<TreeContainerDropZone>;
}>;

export type TreeDropMeasurableRef = Readonly<{
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;

export type TreeDropBoundsRegistration = Readonly<{
    id: string;
    bounds: WindowBounds;
}>;
