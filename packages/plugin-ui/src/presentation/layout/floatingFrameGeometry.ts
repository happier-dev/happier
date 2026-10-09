export type FrameRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type FloatingFrameMode = 'floating' | 'expanded' | 'docked' | 'closed';
export type FloatingFrameGeometry = Readonly<{ rect: FrameRect; fits: boolean }>;

function clamp(value: number, minimum: number, maximum: number): number {
    'worklet';
    return Math.min(maximum, Math.max(minimum, value));
}

export function frameRectsOverlap(a: FrameRect, b: FrameRect): boolean {
    'worklet';
    return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
        && a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Nearest usable placement in measured host space. Obstacle edges enumerate every free pocket;
 * no corner preference, fixed size or obstacle registry belongs to the neutral frame.
 * A host that cannot fit its measured content uses its existing dock composition when fits is false.
 *
 * `aspectRatio` is the body's own width ÷ height; `chromeHeight` is the frame's fixed vertical
 * space around the body (its controls band, gaps and footer), so shrinking keeps the picture's
 * shape instead of squeezing one axis. `minWidth` is the host's measured usable minimum (its
 * controls must fit across): positive space narrower than that is not a usable frame.
 */
export function resolveFloatingFrameRect(input: Readonly<{
    rect: FrameRect;
    availableRect: FrameRect;
    avoidRects?: readonly FrameRect[];
    aspectRatio?: number;
    chromeHeight?: number;
    minWidth?: number;
}>): FloatingFrameGeometry {
    'worklet';
    const available = input.availableRect;
    const availableWidth = Math.max(0, available.width);
    const availableHeight = Math.max(0, available.height);
    const chrome = Math.max(0, input.chromeHeight ?? 0);
    let width = Math.min(Math.max(0, input.rect.width), availableWidth);
    let height = Math.min(Math.max(0, input.rect.height), availableHeight);
    if (input.aspectRatio && input.aspectRatio > 0) {
        width = Math.max(0, Math.min(width, (availableHeight - chrome) * input.aspectRatio));
        height = chrome + width / input.aspectRatio;
    }
    const maxX = available.x + availableWidth - width;
    const maxY = available.y + availableHeight - height;
    const rect = {
        x: clamp(input.rect.x, available.x, maxX),
        y: clamp(input.rect.y, available.y, maxY),
        width, height,
    };
    if (width <= 0 || height - chrome <= 0 || width < (input.minWidth ?? 0)) return { rect, fits: false };
    const obstacles = input.avoidRects ?? [];
    if (!obstacles.some((obstacle) => frameRectsOverlap(rect, obstacle))) return { rect, fits: true };

    const xs = [rect.x, available.x, maxX];
    const ys = [rect.y, available.y, maxY];
    for (const obstacle of obstacles) {
        xs.push(clamp(obstacle.x - width, available.x, maxX), clamp(obstacle.x + obstacle.width, available.x, maxX));
        ys.push(clamp(obstacle.y - height, available.y, maxY), clamp(obstacle.y + obstacle.height, available.y, maxY));
    }
    // Sorting makes equally near placements independent of the shell's obstacle projection order.
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    let closest: FrameRect | null = null;
    let closestDistance = Infinity;
    for (const x of xs) {
        for (const y of ys) {
            const candidate = { x, y, width, height };
            if (obstacles.some((obstacle) => frameRectsOverlap(candidate, obstacle))) continue;
            const distance = (x - rect.x) ** 2 + (y - rect.y) ** 2;
            if (distance < closestDistance) {
                closest = candidate;
                closestDistance = distance;
            }
        }
    }
    return closest ? { rect: closest, fits: true } : { rect, fits: false };
}
