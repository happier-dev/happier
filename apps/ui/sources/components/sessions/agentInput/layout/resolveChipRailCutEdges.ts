export type ChipRailItemEdge = Readonly<{ left: number; right: number }>;

/** The rail's mask: solid up to one chip, clear from the next, so a cut chip goes whole instead of mid-word. */
export type ChipRailCutEdges = Readonly<{
    start?: Readonly<{ clearUntilPx: number; solidFromPx: number }>;
    end?: Readonly<{ solidUntilPx: number; clearFromPx: number }>;
}>;

/** Room the trailing scroll indicator needs: a chip that ends inside it counts as cut (and the reveal clears it). */
export const END_INDICATOR_ROOM_PX = 24;
/** Same overflow test the rail's edge fades use (`useScrollEdgeFades`): a last chip within this of the edge is not overflow. */
const END_OVERFLOW_TOLERANCE_PX = 4;
const START_SCROLL_TOLERANCE_PX = 2;

/**
 * Where a scrolled chip rail should stop showing chips so that every chip it shows is whole.
 *
 * Edges are relative to the rail's left edge. The result is empty when nothing is cut or when no whole
 * chip would remain (a chip wider than the rail): the rail then keeps its ordinary edge fade.
 */
export function resolveChipRailCutEdges(input: Readonly<{
    viewportWidth: number;
    scrollLeft: number;
    items: ReadonlyArray<ChipRailItemEdge>;
}>): ChipRailCutEdges {
    const { viewportWidth, scrollLeft, items } = input;
    const last = items[items.length - 1];
    if (!last) return {};

    let end: ChipRailCutEdges['end'];
    if (last.right > viewportWidth - END_OVERFLOW_TOLERANCE_PX) {
        const cutIndex = items.findIndex((item) => item.right > viewportWidth - END_INDICATOR_ROOM_PX);
        const previous = cutIndex > 0 ? items[cutIndex - 1] : undefined;
        // Hiding a chip that is mostly in view would leave a gap and bury a real control: only a sliver goes.
        const blankPx = viewportWidth - END_INDICATOR_ROOM_PX - (items[cutIndex]?.left ?? viewportWidth);
        if (previous && previous.left >= 0 && blankPx <= END_INDICATOR_ROOM_PX) {
            end = { solidUntilPx: previous.right, clearFromPx: items[cutIndex]!.left };
        }
    }

    let start: ChipRailCutEdges['start'];
    if (scrollLeft > START_SCROLL_TOLERANCE_PX) {
        const inViewIndex = items.findIndex((item) => item.right > 0);
        const cut = inViewIndex >= 0 ? items[inViewIndex] : undefined;
        const next = inViewIndex >= 0 ? items[inViewIndex + 1] : undefined;
        if (cut && cut.left < 0 && cut.right <= END_INDICATOR_ROOM_PX && next && next.left >= 0) {
            start = { clearUntilPx: cut.right, solidFromPx: next.left };
        }
    }

    return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

/**
 * Where a scrolled rail comes to rest (native snap offsets): each chip seated just past the leading
 * indicator's room, so a resting rail never leaves a chip that is mostly in view under the leading cut
 * (the mask would hide all of it and leave a void). `items` are in content coordinates; offsets past the
 * scroll range are dropped, since the range's own end is a rest point.
 */
export function resolveChipRailSnapOffsets(input: Readonly<{
    viewportWidth: number;
    contentWidth: number;
    items: ReadonlyArray<ChipRailItemEdge>;
}>): number[] {
    const maxScroll = input.contentWidth - input.viewportWidth;
    if (maxScroll <= 0) return [];
    const offsets = [0];
    for (const item of input.items.slice(1)) {
        const offset = Math.round(item.left - END_INDICATOR_ROOM_PX);
        if (offset >= maxScroll) break;
        if (offset > offsets[offsets.length - 1]!) offsets.push(offset);
    }
    return offsets;
}
