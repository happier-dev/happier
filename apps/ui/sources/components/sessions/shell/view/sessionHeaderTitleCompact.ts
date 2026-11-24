import * as React from 'react';

/**
 * True while the session title and its whole accessory (the role chip) no longer fit on the title
 * line: the accessory then takes its compact form (the role's mark) instead of being cut to a fragment.
 * The Session header's own title fit (`SessionPaneHeader`), beside its one consumer; the band's action
 * fit is `DetailsTabHeaderActionsCompactContext`.
 */
export const SessionHeaderTitleAccessoryCompactContext = React.createContext(false);

/**
 * True while the header's optional entries (linked-Task chips) are folded into its ⋯: the menu then lists
 * them as rows. Published by `SessionPaneHeader` from {@link shouldFoldSessionHeaderIconActions}.
 */
export const SessionHeaderOptionalEntriesFoldedContext = React.createContext(false);

/**
 * The Session header's fold decision, from its own measured row rather than the viewport, so a narrow
 * desktop pane and a phone fold alike. Optional entries fold first: they leave the title column for ⋯
 * when they would take more of it than they leave (the band's rule for its actions), and the icon
 * actions then take the band's measured compact form. `needPx` is the entries' width measured whole;
 * nothing folds until both widths are known.
 */
export function shouldFoldSessionHeaderIconActions(fit: Readonly<{ roomPx: number | null; needPx: number | null }>): boolean {
    return fit.roomPx !== null && fit.needPx !== null && fit.needPx > 0 && fit.roomPx - fit.needPx < fit.needPx;
}
