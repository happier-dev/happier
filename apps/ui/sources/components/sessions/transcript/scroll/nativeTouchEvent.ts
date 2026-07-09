export const TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX = 12;

export function readNativeTouchPageY(event: unknown): number | null {
    const nativeEvent = (event as { nativeEvent?: unknown } | null | undefined)?.nativeEvent as Record<string, unknown> | undefined;
    if (!nativeEvent) return null;
    const candidates = [
        nativeEvent.pageY,
        nativeEvent.locationY,
        Array.isArray(nativeEvent.touches)
            ? (nativeEvent.touches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
        Array.isArray(nativeEvent.changedTouches)
            ? (nativeEvent.changedTouches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
    }
    return null;
}
