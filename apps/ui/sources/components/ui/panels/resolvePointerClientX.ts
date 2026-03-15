export function resolvePointerClientX(event: unknown): number | null {
    const asAny = event as any;

    const readNumber = (value: unknown): number | null => {
        if (typeof value !== 'number') return null;
        if (!Number.isFinite(value)) return null;
        return value;
    };

    const direct =
        readNumber(asAny?.nativeEvent?.clientX)
        ?? readNumber(asAny?.clientX)
        ?? readNumber(asAny?.nativeEvent?.pageX)
        ?? readNumber(asAny?.pageX);
    if (direct != null) return direct;

    const touch0 = asAny?.touches?.[0] ?? asAny?.changedTouches?.[0] ?? null;
    const touchValue =
        readNumber(touch0?.clientX)
        ?? readNumber(touch0?.pageX);
    if (touchValue != null) return touchValue;

    // Last-ditch: some event shims provide `x` coordinates.
    const xValue = readNumber(asAny?.nativeEvent?.x) ?? readNumber(asAny?.x);
    return xValue;
}
