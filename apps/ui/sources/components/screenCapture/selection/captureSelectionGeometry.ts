export type SelectionPoint = Readonly<{ x: number; y: number }>;
export type SelectionSize = Readonly<{ width: number; height: number }>;
export type SelectionRect = SelectionPoint & SelectionSize;

export function clampSelectionPoint(point: SelectionPoint, display: SelectionSize): SelectionPoint {
    return { x: Math.min(display.width, Math.max(0, point.x)), y: Math.min(display.height, Math.max(0, point.y)) };
}

/** A release is a drag only when both sides passed the gesture slop; anything less picks the window under it (MIS §1.5, §1.9). */
export function classifySelectionRelease(area: SelectionSize, slopPx: number): 'click' | 'drag' {
    return area.width >= slopPx && area.height >= slopPx ? 'drag' : 'click';
}

/** The area a drag spans. It stays on the display it started on: the far corner stops at that display's edge. */
export function dragRectWithinDisplay(start: SelectionPoint, pointer: SelectionPoint, display: SelectionSize): SelectionRect {
    const { x, y } = clampSelectionPoint(pointer, display);
    return {
        x: Math.min(start.x, x),
        y: Math.min(start.y, y),
        width: Math.abs(x - start.x),
        height: Math.abs(y - start.y),
    };
}

/**
 * The size label hangs under the moving corner, outside the area, and comes inside or to the other side
 * within `edge` of a screen edge (MIS §1 Labels).
 */
export function resolveSelectionLabelPosition(
    area: SelectionRect,
    corner: SelectionPoint,
    label: SelectionSize,
    display: SelectionSize,
    edge: number,
): SelectionPoint {
    const gap = edge + 2;
    const below = area.y + area.height + gap;
    const y = below + label.height > display.height - edge
        ? Math.max(edge, area.y + area.height - gap - label.height)
        : below;
    const x = Math.min(display.width - edge - label.width, Math.max(edge, corner.x - label.width));
    return { x, y };
}

function overlaps(a: SelectionRect, b: SelectionRect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The hint gets out of the way only when the area reaches under it (MIS §1 Hint pill). */
export function resolveSelectionHintEdge(area: SelectionRect | null, hint: SelectionRect): 'top' | 'bottom' {
    return area !== null && overlaps(area, hint) ? 'bottom' : 'top';
}
