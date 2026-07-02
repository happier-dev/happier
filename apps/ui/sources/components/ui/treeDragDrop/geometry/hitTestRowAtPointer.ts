/**
 * Coordinate-space-agnostic rectangle hit-testing for tree drag/drop.
 *
 * The same deepest-smallest-match logic is used for window-coordinate hit tests
 * (inside `resolveTreeInstruction`) and content-coordinate hit tests (inside the
 * live geometry registry `useTreeDropRegistry`). Both spaces use identical
 * `{x,y,width,height}` rectangles and `{x,y}` pointers, so these helpers are
 * generic over the rectangle/pointer shapes rather than tied to window space.
 */

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
type Point = Readonly<{ x: number; y: number }>;
type BoundedRow = Readonly<{ depth: number; bounds: Rect }>;

/**
 * True when `pointer` lies inside `bounds`. The bottom and right edges are
 * exclusive so a pointer exactly on the boundary between two stacked rows
 * resolves to the next row, not the previous one.
 */
export function containsPointer(bounds: Rect, pointer: Point): boolean {
    return pointer.x >= bounds.x
        && pointer.x < bounds.x + bounds.width
        && pointer.y >= bounds.y
        && pointer.y < bounds.y + bounds.height;
}

/**
 * Pick the row whose rectangle contains `pointer`, preferring the deepest row
 * and, among equal depths, the smallest area. This makes a nested folder row
 * win over the workspace row it sits inside.
 */
export function hitTestRowAtPointer<Row extends BoundedRow>(
    rows: ReadonlyArray<Row>,
    pointer: Point,
): Row | null {
    const matches = rows.filter((row) => containsPointer(row.bounds, pointer));
    matches.sort((left, right) => {
        if (right.depth !== left.depth) return right.depth - left.depth;
        const leftArea = left.bounds.width * left.bounds.height;
        const rightArea = right.bounds.width * right.bounds.height;
        return leftArea - rightArea;
    });
    return matches[0] ?? null;
}
