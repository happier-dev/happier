import * as React from 'react';

// The rail has 36px controls with 4px of breathing room on either side, on every platform. A finger
// reaches each control through the shared hit area (that breathing room is its reach), so a native
// tablet's rail is no wider than the desktop's.
export const PANE_ACTION_RAIL_WIDTH = 44;

export const PaneActionRailContext = React.createContext<Readonly<{
    visible: boolean;
    contentWidthPx: number;
    mirrored?: boolean;
    /** The rail stands on the shell's canvas beside the page sheet (every right-panel placement on the web shell, R11-1). */
    onCanvas?: boolean;
    /** On the canvas with the side panel docked open beside the rail: its active action is that panel's tab. */
    panelAttached?: boolean;
    /**
     * The rail reports when the attached panel's tab is its first action: that tab continues the top edge of
     * the panel's sheet (its own, or the page it joins), so that sheet squares its top trailing corner into it.
     */
    onPanelTabAtTop?: (atTop: boolean) => void;
    /** The rail has nothing standing on it: where a home for its More exists, its host gives its column back to the page. */
    onVacantChange?: (vacant: boolean) => void;
    /** The focused page's home for a vacant rail's More; absent, the rail keeps its column and its More. */
    vacantMoreHost?: HTMLElement | null;
    rightPaneHiddenByDetails?: RightPaneHiddenByDetails;
}> | null>(null);

/**
 * Whether Details keeps the side column off screen: `true` when showing it means dismissing Details,
 * `'folded'` when Details opened from main only folded it to its rail, so asking for it again shows it
 * beside Details (which becomes the drawer), and `false` when the side column is free to show.
 */
export type RightPaneHiddenByDetails = boolean | 'folded';

export function usePaneActionRail(): boolean {
    return React.useContext(PaneActionRailContext)?.visible ?? false;
}

export function usePaneContentWidth(): number | undefined {
    return React.useContext(PaneActionRailContext)?.contentWidthPx;
}

export function usePaneActionRailRightPaneHiddenByDetails(): RightPaneHiddenByDetails {
    return React.useContext(PaneActionRailContext)?.rightPaneHiddenByDetails ?? false;
}
