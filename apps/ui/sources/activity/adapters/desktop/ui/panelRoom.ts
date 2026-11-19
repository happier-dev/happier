import * as React from 'react';

/**
 * The open panel's room inside the planner's island, for content that scrolls a region of its own (the pinned
 * conversation's turns). `reportOverflow` adds what that region holds past its room to the panel's natural
 * height, so the island keeps asking the planner for all of it.
 */
export type DesktopActivityOverlayPanelRoom = Readonly<{
    available: number | null;
    reportOverflow: (overflow: number) => void;
}>;

export const DesktopActivityOverlayPanelRoomContext = React.createContext<DesktopActivityOverlayPanelRoom | null>(null);
