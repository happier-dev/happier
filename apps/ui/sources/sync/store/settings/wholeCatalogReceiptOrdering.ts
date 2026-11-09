type CatalogRevision = number | 'absent';

/** Whole-row reads and CAS receipts cannot replace membership acknowledged at a newer revision. */
export function canPublishCatalogReceipt(input: Readonly<{
    current: boolean;
    revision: CatalogRevision | undefined;
    retainedRevision?: CatalogRevision;
}>): boolean {
    return input.current && (typeof input.retainedRevision !== 'number'
        || typeof input.revision === 'number' && input.revision >= input.retainedRevision);
}

/** Observed rows establish revision evidence even without readable content or write authority. */
export function retainCatalogRevision(catalog: Readonly<{ status: string; revision?: CatalogRevision }>,
    previous?: CatalogRevision): CatalogRevision {
    return (catalog.status === 'ready' || catalog.status === 'partial' || catalog.status === 'unavailable') && catalog.revision !== undefined
        ? catalog.revision : previous ?? 'absent';
}
