export type WindowRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export function clampWindowCoordinate(position: number, size: number, start: number, length: number, inset: number): number {
    const min = start + inset;
    const max = start + length - inset - size;
    return max < min ? min : Math.min(max, Math.max(min, position));
}

/** Shared Capture/app-window cascade. Callers supply their own content size and chrome metrics. */
export function resolveWindowPlacement(input: Readonly<{
    size: Readonly<{ width: number; height: number }>;
    workArea: WindowRect;
    previousFrame?: WindowRect | null;
    position?: Readonly<{ x: number; y: number }> | null;
    cascadeOffset: number;
    screenInset: number;
}>): WindowRect {
    const { size, workArea, previousFrame, cascadeOffset, screenInset } = input;
    const wanted = previousFrame ? { x: previousFrame.x + cascadeOffset, y: previousFrame.y + cascadeOffset }
        : input.position ?? {
            x: workArea.x + (workArea.width - size.width) / 2,
            y: workArea.y + (workArea.height - size.height) / 2,
        };
    return {
        x: clampWindowCoordinate(wanted.x, size.width, workArea.x, workArea.width, screenInset),
        y: clampWindowCoordinate(wanted.y, size.height, workArea.y, workArea.height, screenInset),
        width: size.width,
        height: size.height,
    };
}
