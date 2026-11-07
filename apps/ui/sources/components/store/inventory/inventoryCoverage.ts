import type { ManagedInventoryView } from './useManagedInventory';

type Families = ManagedInventoryView['families'] & ManagedInventoryView['operationalFamilies'];

/** Preserve native diagnostic codes for the shared disclosure; never put payloads in failure copy. */
export function inventoryFamilyDiagnosticCode(coverage: Families[keyof Families]['coverage']): string | undefined {
    if (typeof coverage !== 'object') return undefined;
    const reason = 'partial' in coverage ? coverage.partial : coverage.unavailable;
    if (typeof reason === 'string') return reason;
    const codes: string[] = [];
    if ('code' in reason && typeof reason.code === 'string') codes.push(reason.code);
    if ('diagnostics' in reason) codes.push(...reason.diagnostics.map(item => item.reason));
    if ('unavailableItems' in reason) codes.push(...(reason.unavailableItems ?? []).map(item => item.reason));
    if ('errorCode' in reason && reason.errorCode) codes.push(reason.errorCode);
    if ('reason' in reason && typeof reason.reason === 'string') codes.push(reason.reason);
    if ('kind' in reason && reason.kind !== 'resolved') codes.push(reason.kind);
    return [...new Set(codes)].join(',') || undefined;
}
