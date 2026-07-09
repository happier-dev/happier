export type SessionEntryViewportSnapshot = Readonly<{
    isPinned: boolean;
    offsetY?: number | null;
    anchor?: unknown | null;
    source?: 'default' | 'observed' | null;
}>;

export function resolveSessionEntryBottomFollow(viewport: SessionEntryViewportSnapshot | null): boolean {
    if (!viewport) return true;
    if (viewport.source !== 'observed') return true;
    return viewport.isPinned === true;
}

export type ResolvedSessionEntryViewportState<TAnchor = unknown> = Readonly<{
    anchor: TAnchor | null;
    bottomFollowMode: 'following' | 'released';
    offsetY: number | null;
    shouldFollowBottom: boolean;
}>;

export function resolveSessionEntryViewportState<TAnchor = unknown>(
    viewport: SessionEntryViewportSnapshot & Readonly<{ anchor?: TAnchor | null }> | null,
): ResolvedSessionEntryViewportState<TAnchor> {
    const shouldFollowBottom = resolveSessionEntryBottomFollow(viewport);
    return {
        anchor: viewport?.anchor ?? null,
        bottomFollowMode: shouldFollowBottom ? 'following' : 'released',
        offsetY: typeof viewport?.offsetY === 'number' && Number.isFinite(viewport.offsetY)
            ? viewport.offsetY
            : null,
        shouldFollowBottom,
    };
}
