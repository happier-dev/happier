import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export function resolveNewSessionAgentPickerSingleSelectFallbackEntry(params: Readonly<{
    selectableBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendTargetKey: string;
}>): ResolvedBackendCatalogEntry | null {
    if (params.selectableBackendEntries.length !== 1) {
        return null;
    }

    const nextEntry = params.selectableBackendEntries[0] ?? null;
    if (nextEntry === null || nextEntry.backendTargetKey === params.selectedBackendTargetKey) {
        return null;
    }

    return nextEntry;
}
