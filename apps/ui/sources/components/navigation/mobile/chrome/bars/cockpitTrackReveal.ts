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
