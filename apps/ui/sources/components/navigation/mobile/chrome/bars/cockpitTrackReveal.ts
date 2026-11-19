/**
 * Where a scrolling phone bar's track scrolls so its selected tab is in view (Plan 30 §457: the selected tab scrolled
 * into view): whole and clear of the edge fade once it moves. Null when it is already in view. At the end, a tab
 * showing at least its half (the track's peek) is in view, so the bar opens at its start rather than cutting its
 * first tab in half (UI refinements 11-18, TRIAGE-W1-BROWSER-A r239).
 */
export function resolveCockpitTrackRevealX(input: Readonly<{ x: number; width: number; offset: number; viewport: number; fade: number }>): number | null {
    const start = input.x - input.fade;
    const end = input.x + input.width + input.fade;
    if (start < input.offset) return Math.max(0, start);
    if (input.x + input.width / 2 > input.offset + input.viewport) return Math.max(0, end - input.viewport);
    return null;
}

/**
 * What the track brings into view: the selected tab. Null for the first tab and for More, which both stand
 * outside the track, and for an item behind More, which moves nothing (owner 11-10).
 */
export function resolveCockpitTrackRevealTarget(tabIds: readonly string[], activeId: string): string | null {
    if (tabIds[0] === activeId) return null;
    return tabIds.includes(activeId) ? activeId : null;
}

/**
 * How wide a scrolling phone bar's visible track is: whole tabs at their own width (the spacing of every other bar,
 * owner 11-15 MOBILE-FIX-1115 H1) plus the leading half of the next tab, so the overflow visibly peeks instead of
 * ending at a hard edge or a sliver (owner 11-18). With no room for a peek beside one tab, one whole tab. The capsule
 * takes back the remainder. Null until the room is measured.
 */
export function resolveCockpitTrackViewportWidth(input: Readonly<{ room: number; minWidth: number }>): number | null {
    if (!(input.room > 0) || !(input.minWidth > 0)) return null;
    const peek = input.minWidth / 2;
    const whole = Math.floor((input.room - peek) / input.minWidth);
    return whole >= 1 ? whole * input.minWidth + peek : Math.min(input.room, input.minWidth);
}
