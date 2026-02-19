import type * as React from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export type SelectableMenuItem = Readonly<{
    id: string;
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
    disabled?: boolean;
}>;

export type SelectableMenuCategory = Readonly<{
    id: string;
    title: string;
    items: ReadonlyArray<SelectableMenuItem>;
}>;
