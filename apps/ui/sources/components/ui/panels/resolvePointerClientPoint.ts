export type PointerClientPoint = Readonly<{ x: number | null; y: number | null }>;

export function resolvePointerClientPoint(event: unknown): PointerClientPoint {
    const asAny = event as any;

    const readNumber = (value: unknown): number | null => {
        if (typeof value !== 'number') return null;
        if (!Number.isFinite(value)) return null;
        return value;
    };

    const directX =
        readNumber(asAny?.nativeEvent?.clientX)
        ?? readNumber(asAny?.clientX)
        ?? readNumber(asAny?.nativeEvent?.pageX)
        ?? readNumber(asAny?.pageX);

    const directY =
        readNumber(asAny?.nativeEvent?.clientY)
        ?? readNumber(asAny?.clientY)
        ?? readNumber(asAny?.nativeEvent?.pageY)
        ?? readNumber(asAny?.pageY);

    if (directX != null || directY != null) {
        return { x: directX ?? null, y: directY ?? null };
    }

    const touch0 = asAny?.touches?.[0] ?? asAny?.changedTouches?.[0] ?? null;
    const touchX = readNumber(touch0?.clientX) ?? readNumber(touch0?.pageX);
    const touchY = readNumber(touch0?.clientY) ?? readNumber(touch0?.pageY);
    if (touchX != null || touchY != null) {
        return { x: touchX ?? null, y: touchY ?? null };
    }

    // Last-ditch: some event shims provide `x`/`y` coordinates.
    const xValue = readNumber(asAny?.nativeEvent?.x) ?? readNumber(asAny?.x);
    const yValue = readNumber(asAny?.nativeEvent?.y) ?? readNumber(asAny?.y);
    return { x: xValue ?? null, y: yValue ?? null };
}
