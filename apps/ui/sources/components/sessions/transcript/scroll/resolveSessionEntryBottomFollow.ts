export type SessionEntryViewportSnapshot = Readonly<{
    isPinned: boolean;
    source?: 'default' | 'observed' | null;
}>;

export function resolveSessionEntryBottomFollow(viewport: SessionEntryViewportSnapshot | null): boolean {
    if (!viewport) return true;
    if (viewport.source !== 'observed') return true;
    return viewport.isPinned === true;
}
