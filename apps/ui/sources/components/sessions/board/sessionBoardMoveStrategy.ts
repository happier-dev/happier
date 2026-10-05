export type SessionBoardItemRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type SessionBoardAnchoredMove = Readonly<{
    side: 'before' | 'after';
    itemId: string;
}>;

/** Resolve a one-based staged keyboard position to the existing semantic anchor. */
export function resolveSessionBoardKeyboardAnchor(input: Readonly<{
    draggedId: string;
    orderedIds: readonly string[];
    targetPosition: number;
}>): SessionBoardAnchoredMove | null {
    const currentIndex = input.orderedIds.indexOf(input.draggedId);
    if (currentIndex < 0 || !Number.isInteger(input.targetPosition)) return null;
    const desiredIndex = input.targetPosition - 1;
    if (desiredIndex < 0 || desiredIndex >= input.orderedIds.length || desiredIndex === currentIndex) return null;
    const withoutDragged = input.orderedIds.filter((itemId) => itemId !== input.draggedId);
    if (desiredIndex >= withoutDragged.length) {
        const last = withoutDragged.at(-1);
        return last ? { side: 'after', itemId: last } : null;
    }
    const anchor = withoutDragged[desiredIndex];
    return anchor ? { side: 'before', itemId: anchor } : null;
}

/** Geometry projects a completed drop to a semantic anchor; pixels stay viewer-local. */
export function resolveSessionBoardAnchoredPointerDrop(input: Readonly<{
    draggedId: string;
    orderedIds: readonly string[];
    itemRects: ReadonlyMap<string, SessionBoardItemRect>;
    translationX: number;
    translationY: number;
    droppedInside: boolean;
}>): SessionBoardAnchoredMove | null {
    if (!input.droppedInside || !Number.isFinite(input.translationX) || !Number.isFinite(input.translationY)) return null;
    const draggedRect = input.itemRects.get(input.draggedId);
    if (!draggedRect || !input.orderedIds.includes(input.draggedId)) return null;

    const dropX = draggedRect.x + (draggedRect.width / 2) + input.translationX;
    const dropY = draggedRect.y + (draggedRect.height / 2) + input.translationY;
    const targetId = input.orderedIds.find((itemId) => {
        if (itemId === input.draggedId) return false;
        const rect = input.itemRects.get(itemId);
        return rect !== undefined
            && dropX >= rect.x && dropX <= rect.x + rect.width
            && dropY >= rect.y && dropY <= rect.y + rect.height;
    });
    if (!targetId) return null;
    const target = input.itemRects.get(targetId);
    if (!target) return null;
    const horizontal = Math.abs(input.translationX) >= Math.abs(input.translationY);
    const side = horizontal
        ? (dropX < target.x + (target.width / 2) ? 'before' : 'after')
        : (dropY < target.y + (target.height / 2) ? 'before' : 'after');

    const current = input.orderedIds;
    const withoutDragged = current.filter((itemId) => itemId !== input.draggedId);
    const anchorIndex = withoutDragged.indexOf(targetId);
    if (anchorIndex < 0) return null;
    const insertionIndex = anchorIndex + (side === 'after' ? 1 : 0);
    const next = [
        ...withoutDragged.slice(0, insertionIndex),
        input.draggedId,
        ...withoutDragged.slice(insertionIndex),
    ];
    return next.every((itemId, index) => itemId === current[index]) ? null : { side, itemId: targetId };
}
