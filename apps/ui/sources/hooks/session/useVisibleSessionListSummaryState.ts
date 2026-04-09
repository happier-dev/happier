import * as React from 'react';

import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';
import {
    resolveVisibleSessionListIndexSummary,
    type VisibleSessionListSummary,
} from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export type VisibleSessionListSummaryState = Readonly<{
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    summary: VisibleSessionListSummary;
}>;

export function useVisibleSessionListSummaryState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListSummaryState {
    const { selection, activeIndex, byServerId } = useVisibleSessionListSourceState();

    const summary = React.useMemo(() => resolveVisibleSessionListIndexSummary({
        enabled: selection.enabled,
        activeServerId: selection.activeServerId,
        activeIndex,
        byServerId,
        selectedServerIds: selection.allowedServerIds,
    }, storageFilter), [
        activeIndex,
        byServerId,
        selection.activeServerId,
        selection.allowedServerIds,
        selection.enabled,
        storageFilter,
    ]);

    return React.useMemo(() => ({
        selection,
        summary,
    }), [selection, summary]);
}
