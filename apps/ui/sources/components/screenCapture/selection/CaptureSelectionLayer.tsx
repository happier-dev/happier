import type * as React from 'react';

import type { SelectionPoint, SelectionRect, SelectionSize } from './captureSelectionGeometry';

export type CaptureSelectionMode = 'still' | 'recording';
export type CaptureSelectionWindow = Readonly<{
    windowId: number;
    /** Local to this display. */
    frame: SelectionRect;
    appName: string | null;
    title: string | null;
}>;
export type CaptureSelectionCommit =
    | Readonly<{ kind: 'window'; window: CaptureSelectionWindow }>
    | Readonly<{ kind: 'rect'; rect: SelectionRect; under: CaptureSelectionWindow | null }>;
export type CaptureSelectionLayerProps = Readonly<{
    display: SelectionSize;
    /** The top inset on a notched display: the hint sits below it. */
    safeAreaTop: number;
    /** Selectable windows, frontmost first, for keyboard cycling. */
    windows: readonly CaptureSelectionWindow[];
    /** The native owner decides what is under a point; this layer never trusts its own hit-testing. */
    hitTest: (point: SelectionPoint) => Promise<CaptureSelectionWindow | null>;
    mode: CaptureSelectionMode;
    onModeChange: (mode: CaptureSelectionMode) => void;
    /** The bound capture shortcut, as shown in the hint. */
    shortcutLabel?: string;
    initialPointer?: SelectionPoint;
    onCommit: (commit: CaptureSelectionCommit) => void;
    onCancel: () => void;
    testID?: string;
}>;

/** The selection layer exists only on desktop webviews; phones never reach this route. */
export function CaptureSelectionLayer(_props: CaptureSelectionLayerProps): React.ReactElement | null {
    return null;
}
