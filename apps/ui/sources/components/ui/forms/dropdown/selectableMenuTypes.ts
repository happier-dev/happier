import type * as React from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export type SelectableMenuItem = Readonly<{
    id: string;
    testID?: string;
    /**
     * Stable text used for filtering and accessibility. Prefer a plain string here.
     * For custom visual presentation (e.g. inline chips), use `titleNode`.
     */
    title: string;
    subtitle?: string;
    /** Optional custom presentation for title/subtitle (web/native Text-compatible). */
    titleNode?: React.ReactNode;
    subtitleNode?: React.ReactNode;
    /** Optional per-row presentation overrides (SelectableRow only). */
    rowContainerStyle?: StyleProp<ViewStyle>;
    rowTitleStyle?: StyleProp<TextStyle>;
    rowSubtitleStyle?: StyleProp<TextStyle>;
    leftGap?: number;
    /** Used for grouping headers (optional). */
    category?: string;
    /** Optional left/right visuals (icon, shortcut chip, checkmark, etc). */
    left?: React.ReactNode;
    right?: React.ReactNode;
    hasSubmenu?: boolean;
    disabled?: boolean;
    /** Renders the option as a round colour choice; consecutive swatches share one wrapped row. */
    swatch?: SelectableMenuSwatch;
}>;

export type SelectableMenuSwatch = Readonly<{
    /** Resolved paint for the swatch. */
    color: string;
    /** The current choice; shown as a ring and exposed as the selected state. */
    checked?: boolean;
    /** Shown but not owned (e.g. a project colour a session inherits): a quieter ring, never `selected`. */
    inherited?: boolean;
    /** No colour: an empty ring struck through (the Remove choice), in the same row and radio semantics. */
    empty?: boolean;
    /** Consecutive swatches with the same group render together; a new group starts a new row. */
    group?: string;
}>;

export type SelectableMenuCategory = Readonly<{
    id: string;
    title: string;
    items: ReadonlyArray<SelectableMenuItem>;
}>;
