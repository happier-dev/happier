import * as React from 'react';

/**
 * How far free content in a bare section stands in from the section's edge to meet its rows' text edge (0 when it
 * already does). A menu section's rows bring the menu inset and its free content (a button row) has none, so it reads
 * this to take the same inset. `ItemGroup` provides it.
 */
export const BareRowBleedContext = React.createContext(0);

export function useBareRowBleedPx(): number {
    return React.useContext(BareRowBleedContext);
}

/**
 * How far each row of a bare section reaches past the section's content on both sides. In a contained scope (a widget
 * body or flow column that owns its padding) it is the row's own inset, so its mark and title keep the column's edge;
 * on a page it is that inset less the heading's optical inset, so its mark and chevron stand on the edges the section's
 * tiles, collections and title stand on. Either way the press fill and dividers reach into the margin. Only rows read it (`useSectionRowBleedStyle`); free content in the section (tiles, notes,
 * a Collection) stays inside the column, which may clip at its edge. `ItemGroup` provides it; a new list scope or a
 * Collection starts at 0.
 */
export const SectionRowBleedContext = React.createContext(0);

const rowBleedStyles = new Map<number, Readonly<{ marginHorizontal: number }>>();

/**
 * The style a row (`Item`, `SectionContentRow`, the section's loading rows) takes on its outermost box to reach
 * past the column by `SectionRowBleedContext`, or null where it does not bleed.
 */
export function useSectionRowBleedStyle(): Readonly<{ marginHorizontal: number }> | null {
    const bleedPx = React.useContext(SectionRowBleedContext);
    if (bleedPx <= 0) return null;
    let style = rowBleedStyles.get(bleedPx);
    if (!style) {
        style = Object.freeze({ marginHorizontal: -bleedPx });
        rowBleedStyles.set(bleedPx, style);
    }
    return style;
}
