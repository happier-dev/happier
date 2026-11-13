/**
 * True when every change row a reader owns is already held at that row's
 * revision or later (its own acknowledged write), so the row carries nothing new
 * for it. A row without a revision, a reader without a held revision, and the
 * Account settings row (`self`) never qualify.
 */
export function changeRowsAlreadyHeld(
    entityIds: readonly string[],
    entityRevisions: Readonly<Record<string, number>>,
    owns: (entityId: string) => boolean,
    heldRevision: (entityId: string) => number | undefined,
): boolean {
    const owned = entityIds.filter(id => id === 'self' || owns(id));
    return owned.length > 0 && owned.every(id => {
        if (id === 'self') return false;
        const revision = entityRevisions[id];
        const held = heldRevision(id);
        return revision !== undefined && held !== undefined && held >= revision;
    });
}
