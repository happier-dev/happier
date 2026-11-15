/**
 * Where a scrolling phone bar's track scrolls so its selected tab is whole and clear of the edge fade (Plan 30 §457:
 * the selected tab scrolled into view). Null when it already is.
 */
export function resolveCockpitTrackRevealX(input: Readonly<{ x: number; width: number; offset: number; viewport: number; fade: number }>): number | null {
    const start = input.x - input.fade;
    const end = input.x + input.width + input.fade;
    if (start < input.offset) return Math.max(0, start);
    if (end > input.offset + input.viewport) return Math.max(0, end - input.viewport);
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
 * How wide a scrolling phone bar's visible track is: a whole number of tabs at their own width, so its edge falls
 * between two tabs (no glyph stub of a half-shown tab at rest, PHONE-ROWS-HUNT) and its tabs keep the spacing of every
 * other bar (owner 11-15, MOBILE-FIX-1115 H1); the capsule takes back the remainder. Null until the room is measured.
 */
export function resolveCockpitTrackViewportWidth(input: Readonly<{ room: number; minWidth: number }>): number | null {
    if (!(input.room > 0) || !(input.minWidth > 0)) return null;
    return Math.min(input.room, Math.max(1, Math.floor(input.room / input.minWidth)) * input.minWidth);
}
