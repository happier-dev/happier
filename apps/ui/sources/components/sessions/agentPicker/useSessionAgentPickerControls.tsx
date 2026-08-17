import * as React from 'react';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

type UseSessionAgentPickerControlsParams = Readonly<{
    options: ReadonlyArray<AgentInputChipPickerOption> | undefined;
    /** A remembered or armed row, honoured only while it is still in the catalog. */
    preferredOptionId?: string | null;
    /** The row shown as selected when no preferred row applies. */
    fallbackOptionId?: string | null;
    /**
     * Entries a caller is willing to dispatch a selection to. A surface where choosing
     * a row must not change anything by itself simply leaves this out.
     */
    selectableEntries?: readonly ResolvedBackendCatalogEntry[];
    onSelectEntry?: (entry: ResolvedBackendCatalogEntry) => void;
    /** Rows that are not Agent catalog entries, such as the favorite-models view. */
    onSelectNonEntryOption?: (optionId: string) => void;
}>;

export type SessionAgentPickerControls = Readonly<{
    agentPickerSelectedOptionId: string | null;
    handleAgentPickerSelect: (selectedId: string) => void;
}>;

/**
 * Shared selection plumbing for every Agent picker surface.
 *
 * It answers which row reads as selected — never a row the catalog no longer offers,
 * so a remembered or armed choice cannot outlive the Agent it named — and routes a
 * chosen row back to its catalog entry. It deliberately owns no authoring, draft, or
 * model state: the caller keeps that where it already lives.
 */
export function useSessionAgentPickerControls(
    params: UseSessionAgentPickerControlsParams,
): SessionAgentPickerControls {
    const { options, preferredOptionId, fallbackOptionId } = params;

    const agentPickerSelectedOptionId = React.useMemo(() => {
        const fallback = fallbackOptionId ?? null;
        if (typeof preferredOptionId !== 'string' || preferredOptionId.length === 0) {
            return fallback;
        }
        const isPreferredPresent = (options ?? []).some((option) => option.id === preferredOptionId);
        return isPreferredPresent ? preferredOptionId : fallback;
    }, [fallbackOptionId, options, preferredOptionId]);

    const selectableEntriesRef = React.useRef(params.selectableEntries);
    selectableEntriesRef.current = params.selectableEntries;
    const onSelectEntryRef = React.useRef(params.onSelectEntry);
    onSelectEntryRef.current = params.onSelectEntry;
    const onSelectNonEntryOptionRef = React.useRef(params.onSelectNonEntryOption);
    onSelectNonEntryOptionRef.current = params.onSelectNonEntryOption;

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        const nextEntry = (selectableEntriesRef.current ?? [])
            .find((entry) => entry.backendTargetKey === selectedId) ?? null;
        if (!nextEntry) {
            onSelectNonEntryOptionRef.current?.(selectedId);
            return;
        }
        onSelectEntryRef.current?.(nextEntry);
    }, []);

    return {
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
    };
}
