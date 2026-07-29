/**
 * The single guarded read of the renderer's native absolute-scroll fact.
 *
 * Renderer state can be unavailable during recycling or identity changes, and adapters may
 * throw while rebuilding. Centralizing the guarded finite-or-null contract keeps every
 * observation owner consistent.
 */
export function readNativeAbsoluteScrollOffset(
    node: Readonly<{ getAbsoluteLastScrollOffset?: () => number }> | null | undefined,
): number | null {
    try {
        const value = node?.getAbsoluteLastScrollOffset?.();
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}
