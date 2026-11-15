import type { ManagedInventoryView } from './useManagedInventory';

type Families = ManagedInventoryView['families'] & ManagedInventoryView['operationalFamilies'];

/** Preserve native diagnostic codes for the shared disclosure; never put payloads in failure copy. */
export function inventoryFamilyDiagnosticCode(coverage: Families[keyof Families]['coverage']): string | undefined {
    if (typeof coverage !== 'object') return undefined;
    const reason = 'partial' in coverage ? coverage.partial : coverage.unavailable;
    if (typeof reason === 'string') return reason;
    // Per-Machine failures (Browser extensions): each Machine's typed reason, e.g. managed_browser_required.
    if (Array.isArray(reason)) {
        return [...new Set((reason as readonly unknown[]).flatMap(readMachineFailureCode))].join(',') || undefined;
    }
    const codes: string[] = [];
    if ('code' in reason && typeof reason.code === 'string') codes.push(reason.code);
    if ('diagnostics' in reason) codes.push(...reason.diagnostics.map(item => item.reason));
    if ('unavailableItems' in reason) codes.push(...(reason.unavailableItems ?? []).map(item => item.reason));
    if ('errorCode' in reason && reason.errorCode) codes.push(reason.errorCode);
    if ('reason' in reason && typeof reason.reason === 'string') codes.push(reason.reason);
    if ('kind' in reason && reason.kind !== 'resolved') codes.push(reason.kind);
    return [...new Set(codes)].join(',') || undefined;
}

/** One Machine's failure entry (`{ machineId, reason }`): the browser's code, the Action's code, else its kind. */
function readMachineFailureCode(entry: unknown): string[] {
    const reason = entry && typeof entry === 'object' && 'reason' in entry ? entry.reason : null;
    if (!reason || typeof reason !== 'object') return [];
    const value = 'value' in reason && reason.value && typeof reason.value === 'object' ? reason.value : null;
    const code = value && 'code' in value ? value.code : 'code' in reason ? reason.code : 'kind' in reason ? reason.kind : null;
    return typeof code === 'string' ? [code] : [];
}

/**
 * What a partial read means for its section: still `arriving` (the pending glyph), more held behind the section's own
 * Next/All (`paged`: nothing to add), or settled short of everything (`incomplete`: a Machine or source didn't answer).
 * Pending, settled and failed stay three states; a settled page never keeps the pending glyph.
 */
export function partialInventoryCoverageState(reason: unknown): 'arriving' | 'paged' | 'incomplete' {
    if (typeof reason === 'string') return reason.endsWith('_loading') ? 'arriving' : reason.endsWith('_page') ? 'paged' : 'incomplete';
    if (reason && typeof reason === 'object') {
        if (('hasNextPage' in reason && reason.hasNextPage === true) || ('hasPreviousPage' in reason && reason.hasPreviousPage === true)) return 'paged';
        // A Machine-list snapshot: `settled` is present only once the list is read and current; until then a read still
        // in flight (no inventory status yet, or loading) is arriving, and a failed or signed-out one settled short.
        if ('observation' in reason) {
            const status = 'inventoryStatus' in reason ? reason.inventoryStatus : undefined;
            return ('settled' in reason && reason.settled === true) || (status !== undefined && status !== 'loading')
                ? 'incomplete' : 'arriving';
        }
        if ('settled' in reason && reason.settled !== true) return 'arriving';
        if ('status' in reason && reason.status === 'loading') return 'arriving';
    }
    return 'incomplete';
}
