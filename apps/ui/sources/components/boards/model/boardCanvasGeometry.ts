/**
 * Canvas geometry for Boards: where a card lands when dropped or moved by keyboard, and how many
 * card columns the unplaced cards flow into. Positions are logical pixels from the canvas origin and
 * are the user's data (`positionsByItemRef`); they are kept on phones, which show By status only.
 */
export const BOARD_CANVAS_METRICS = Object.freeze({
    /** The snap grid, and the keyboard's move step. */
    gridStepPx: 24,
    cardWidthPx: 400,
    gapPx: 24,
    /** The canvas's inner margin, so a card at the origin does not touch the page edge. */
    paddingPx: 24,
});

export type BoardCanvasPoint = Readonly<{ x: number; y: number }>;
export type BoardCanvasDirection = 'up' | 'down' | 'left' | 'right';

function snapValue(value: number): number {
    const step = BOARD_CANVAS_METRICS.gridStepPx;
    return Math.round(value / step) * step;
}

function clampToCanvas(point: BoardCanvasPoint): BoardCanvasPoint {
    return { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) };
}

/**
 * Snapping on: the nearest grid point. Off: exactly where it was released, unless ⇧ was held for this
 * drop (`snapOnce`). Never off the canvas.
 */
export function resolveBoardCardDrop(input: Readonly<{
    origin: BoardCanvasPoint;
    translation: BoardCanvasPoint;
    snap: boolean;
    snapOnce?: boolean;
}>): BoardCanvasPoint {
    const x = input.origin.x + input.translation.x;
    const y = input.origin.y + input.translation.y;
    return clampToCanvas(input.snap || input.snapOnce === true ? { x: snapValue(x), y: snapValue(y) } : { x, y });
}

/** An arrow key moves a focused card one grid step, first settling a free position onto the grid. */
export function moveBoardCardByKeyboard(position: BoardCanvasPoint, direction: BoardCanvasDirection): BoardCanvasPoint {
    const step = BOARD_CANVAS_METRICS.gridStepPx;
    const x = snapValue(position.x);
    const y = snapValue(position.y);
    switch (direction) {
        case 'up': return clampToCanvas({ x, y: y - step });
        case 'down': return clampToCanvas({ x, y: y + step });
        case 'left': return clampToCanvas({ x: x - step, y });
        case 'right': return clampToCanvas({ x: x + step, y });
    }
}

/** How many card columns fit in the canvas width; unplaced cards flow into them. */
export function resolveBoardCanvasColumnCount(widthPx: number, snap = false): number {
    const { cardWidthPx, gapPx } = BOARD_CANVAS_METRICS;
    const stride = snap ? ceilToGrid(cardWidthPx + gapPx) : cardWidthPx + gapPx;
    return Math.max(1, Math.floor((widthPx - cardWidthPx) / stride) + 1);
}

function ceilToGrid(value: number): number {
    return Math.ceil(value / BOARD_CANVAS_METRICS.gridStepPx) * BOARD_CANVAS_METRICS.gridStepPx;
}

export type BoardCanvasFootprint = Readonly<{ key: string; width: number; height: number }>;

/** One placement owner for saved XY and measured auto cards. Auto positions are visit-local only. */
export function resolveBoardCanvasPositions(input: Readonly<{
    members: readonly BoardCanvasFootprint[];
    positionsByItemRef: Readonly<Record<string, BoardCanvasPoint>>;
    columnCount: number;
    snap: boolean;
    previous: ReadonlyMap<string, BoardCanvasPoint>;
}>): ReadonlyMap<string, BoardCanvasPoint> {
    const { cardWidthPx, gapPx } = BOARD_CANVAS_METRICS;
    const stride = input.snap ? ceilToGrid(cardWidthPx + gapPx) : cardWidthPx + gapPx;
    const right = (input.columnCount - 1) * stride + cardWidthPx;
    const occupied: (BoardCanvasFootprint & BoardCanvasPoint)[] = [];
    const next = new Map<string, BoardCanvasPoint>();
    const intersects = (member: BoardCanvasFootprint, point: BoardCanvasPoint, other: BoardCanvasFootprint & BoardCanvasPoint) =>
        point.x < other.x + other.width + gapPx && other.x < point.x + member.width + gapPx
        && point.y < other.y + other.height + gapPx && other.y < point.y + member.height + gapPx;
    const place = (member: BoardCanvasFootprint, point: BoardCanvasPoint) => {
        const previous = input.previous.get(member.key);
        next.set(member.key, previous?.x === point.x && previous.y === point.y ? previous : point);
        occupied.push({ ...member, ...point });
    };
    // Reserve every hand-placed rectangle before considering any auto card, regardless of Board order.
    for (const member of input.members) {
        const saved = input.positionsByItemRef[member.key];
        if (saved) place(member, saved);
    }
    // Auto flow is a projection of the current members, not saved layout. Recompute in Board
    // order so filtering closes vacated slots; identical inputs still reuse each point and map.
    for (const member of input.members) {
        if (input.positionsByItemRef[member.key]) continue;
        let best: BoardCanvasPoint | null = null;
        for (let column = 0; column < input.columnCount; column += 1) {
            const x = column * stride;
            if (column > 0 && x + member.width > right) break;
            let y = 0;
            for (;;) {
                const hits = occupied.filter(other => intersects(member, { x, y }, other));
                if (!hits.length) break;
                y = Math.max(...hits.map(other => other.y + other.height + gapPx));
                if (input.snap) y = ceilToGrid(y);
            }
            if (!best || y < best.y) best = { x, y };
        }
        place(member, best!);
    }
    return next.size === input.previous.size && [...next].every(([key, point]) => input.previous.get(key) === point)
        ? input.previous : next;
}
