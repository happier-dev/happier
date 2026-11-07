import type * as React from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

/** Stable matching/identity metadata; presentation is materialized only for a demanded row. */
export type MenuItemSource<Item> = Readonly<{
    items: readonly Item[];
    indexById: ReadonlyMap<string, number>;
    getItem(index: number): Item | undefined;
}>;

export type SelectableMenuItemSource = MenuItemSource<SelectableMenuItem>;

export type SelectableMenuItem = Readonly<{
    id: string;
    /** Optional stable DOM/test identifier for the rendered row. */
    testID?: string;
    /**
     * Stable text used for filtering and accessibility. Prefer a plain string here.
     * For custom visual presentation (e.g. inline chips), use `titleNode`.
     */
    title: string;
    subtitle?: string;
    accessibilityLabel?: string;
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
    /** Current choice state, independent of keyboard highlight. */
    checked?: boolean;
    /** Renders the option as a round colour choice; consecutive swatches of one group share a row. */
    swatch?: SelectableMenuSwatch;
}>;

export type SelectableMenuSwatch = Readonly<{
    /** Resolved paint for the swatch. */
    color: string;
    /** Shown but not owned (a project colour a session inherits): a quieter ring; the item stays unchecked. */
    inherited?: boolean;
    /** No colour: an empty ring struck through (the Remove choice), in the same row and radio semantics. */
    empty?: boolean;
    /** Consecutive swatches with the same group render together and move sideways from the keyboard. */
    group?: string;
}>;

export type SelectableMenuCategory = Readonly<{
    id: string;
    title: string;
    items: ReadonlyArray<SelectableMenuItem>;
}>;

/** Keyed by category title: the section's identity mark (agent, provider) and one quiet line under its rows. */
export type SelectableMenuCategoryDecorations = Readonly<Record<string, Readonly<{ icon?: React.ReactNode; note?: string }>>>;
