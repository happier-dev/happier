import * as React from 'react';

import { collectSplitCanvasLeafRects } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import type { WorkspaceState } from '../workspaceState';

/** A top-row pane's horizontal span in window coordinates. */
export type WorkspaceBarFrame = Readonly<{ x: number; width: number }>;

export const WORKSPACE_BAR_CONTROL_GAP_PX = 12;

/** Clip a measured pane to the title strip's actual interactive control reservations. */
export function resolveWorkspaceBarSegmentFrame(input: Readonly<{
    frame: WorkspaceBarFrame;
    originX: number;
    leadingEndPx: number;
    trailingStartPx?: number;
}>): Readonly<{ paneLeft: number; left: number; width: number }> | null {
    const paneLeft = input.frame.x - input.originX;
    const left = Math.max(paneLeft, input.leadingEndPx);
    const right = Math.min(paneLeft + input.frame.width, input.trailingStartPx ?? Infinity);
    const width = right - left;
    return width > 0 ? { paneLeft, left, width } : null;
}

/**
 * Where the window's title strip is and where each top-row pane sits under it, so the strip can lay
 * each pane's tabs exactly over that pane (workspace lab T/S: "each top-row pane's tabs sit directly
 * above it"). Presentation geometry only: the workspace owner keeps tabs, groups and focus; this holds
 * the measured spans its two placements need to line up.
 */
export type WorkspaceBarGeometry = Readonly<{
    setGroupFrame: (groupId: string, frame: WorkspaceBarFrame | null) => void;
    subscribe: (listener: () => void) => () => void;
    getFrames: () => ReadonlyMap<string, WorkspaceBarFrame>;
}>;

export function createWorkspaceBarGeometry(): WorkspaceBarGeometry {
    let frames: ReadonlyMap<string, WorkspaceBarFrame> = new Map();
    const listeners = new Set<() => void>();
    return {
        setGroupFrame: (groupId, frame) => {
            const current = frames.get(groupId);
            if (frame === null ? current === undefined : current?.x === frame.x && current?.width === frame.width) return;
            const next = new Map(frames);
            if (frame === null) next.delete(groupId);
            else next.set(groupId, frame);
            frames = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getFrames: () => frames,
    };
}

/** Present only where the shell draws a title strip that can carry the top row's tabs. */
export const WorkspaceBarGeometryContext = React.createContext<WorkspaceBarGeometry | null>(null);

export function useWorkspaceBarFrames(geometry: WorkspaceBarGeometry): ReadonlyMap<string, WorkspaceBarFrame> {
    return React.useSyncExternalStore(geometry.subscribe, geometry.getFrames, geometry.getFrames);
}

/**
 * The panes whose top edge is the canvas's top edge, left to right: their tabs belong in the title
 * strip; every other pane keeps a strip of its own. A maximized pane is the whole top row.
 */
export function resolveWorkspaceTopRowGroupIds(state: Pick<WorkspaceState, 'root' | 'maximizedGroupId'>): readonly string[] {
    if (state.maximizedGroupId) return [state.maximizedGroupId];
    return collectSplitCanvasLeafRects(state.root)
        .filter((rect) => rect.y === 0)
        .sort((first, second) => first.x - second.x)
        .map((rect) => rect.leafId);
}
