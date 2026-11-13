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
 * How wide each tab of a scrolling phone bar's track is, so a whole number of tabs fills the visible track and its
 * edge falls between two tabs, never through one: no glyph stub of a half-shown tab at rest (phone row rule,
 * PHONE-ROWS-HUNT). Null until the track is measured; tabs keep their own width meanwhile.
 */
export function resolveCockpitTrackItemWidth(input: Readonly<{ viewport: number; minWidth: number }>): number | null {
    if (!(input.viewport > 0) || !(input.minWidth > 0)) return null;
    const whole = Math.max(1, Math.floor(input.viewport / input.minWidth));
    return input.viewport / whole;
}
