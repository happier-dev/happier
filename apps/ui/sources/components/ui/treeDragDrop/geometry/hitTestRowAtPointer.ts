import type { TreeRow, WindowBounds, WindowPointer } from '../treeDragDropTypes';

export function containsWindowPointer(bounds: WindowBounds, pointer: WindowPointer): boolean {
    return pointer.x >= bounds.x
        && pointer.x < bounds.x + bounds.width
        && pointer.y >= bounds.y
        && pointer.y < bounds.y + bounds.height;
}

export function hitTestRowAtPointer(
    rows: ReadonlyArray<TreeRow>,
    pointer: WindowPointer,
): TreeRow | null {
    const matches = rows.filter((row) => containsWindowPointer(row.bounds, pointer));
    matches.sort((left, right) => {
        if (right.depth !== left.depth) return right.depth - left.depth;
        const leftArea = left.bounds.width * left.bounds.height;
        const rightArea = right.bounds.width * right.bounds.height;
        return leftArea - rightArea;
    });
    return matches[0] ?? null;
}
