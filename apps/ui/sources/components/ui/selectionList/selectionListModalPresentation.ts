import { resolvePopoverSelectionListHeightBehavior } from './resolvePopoverSelectionListHeightBehavior';
import type { SelectionListHeightBehavior } from './_types';

/**
 * A SelectionList hosted in a card modal sizes the card to its rows, up to the viewport bound, and
 * scrolls inside it (the SelectionList container shrinks into the card, so on a short viewport the
 * rows scroll while the search header and any footer stay visible). `scrollHost: 'body'` would pin
 * the card to that bound, leaving a short list at the top of an empty card.
 */
export const SELECTION_LIST_MODAL_CARD_SCROLL = {
    scrollHost: 'bounded',
    bodyScroll: 'none',
} as const;

/**
 * The tallest a card-modal picker grows; shorter lists keep the card to their rows
 * (`resolveSelectionListModalHeightBehavior`).
 */
export const SELECTION_LIST_MODAL_MAX_HEIGHT = 520;

/**
 * Searching narrows the rows, but the centered card keeps its height instead of re-centering with
 * every keystroke; it settles to the new content after typing pauses.
 */
export function resolveSelectionListModalHeightBehavior(): SelectionListHeightBehavior | undefined {
    return resolvePopoverSelectionListHeightBehavior('stabilizedContentHeight');
}
