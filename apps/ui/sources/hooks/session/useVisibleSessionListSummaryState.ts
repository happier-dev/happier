import * as React from 'react';

import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';
import {
    resolveVisibleSessionListSummary,
    type VisibleSessionListSummary,
} from '@/sync/domains/session/listing/sessionListPresentation';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export type VisibleSessionListSummaryState = Readonly<{
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    summary: VisibleSessionListSummary;
}>;

export function useVisibleSessionListSummaryState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListSummaryState {
    const { selection, activeData, byServerId } = useVisibleSessionListSourceState();

    const summary = React.useMemo(() => resolveVisibleSessionListSummary({
        enabled: selection.enabled,
        activeServerId: selection.activeServerId,
        activeData,
        byServerId,
        selectedServerIds: selection.allowedServerIds,
    }, storageFilter), [
        activeData,
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
