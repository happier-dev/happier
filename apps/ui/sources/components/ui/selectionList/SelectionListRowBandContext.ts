import * as React from 'react';

/** An option's expanded content, painted by its grid row under the whole row (lab A2, owner pick 2026-11-18). */
export type SelectionListRowBand = Readonly<{
    /** DOM id of the band, which the option's gridcell owns (`aria-owns`) so it reads as part of that cell. */
    id: string;
    content: React.ReactNode;
}>;

/**
 * Set by a multi-column `SelectionListColumnRow` for each of its cells. An option row inside it hands its expanded
 * content to the row (or `null` when it collapses) instead of drawing it inside its own card, so the content
 * spans every column of the row rather than one card's width. Absent outside a columned grid.
 */
export const SelectionListRowBandContext = React.createContext<((band: SelectionListRowBand | null) => void) | null>(null);
