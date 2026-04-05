import * as React from 'react';

import { useSessionListSelectionState } from './useSessionListSelectionState';
import { useServerScopedSessionListCache, useSessionListViewData } from '@/sync/domains/state/storage';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

export type VisibleSessionListSourceState = Readonly<{
    selection: ReturnType<typeof useSessionListSelectionState>;
    activeData: ReadonlyArray<SessionListViewItem> | null;
    byServerId: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null | undefined>>;
    source: ReadonlyArray<SessionListViewItem> | null;
}>;

export function useVisibleSessionListSourceState(): VisibleSessionListSourceState {
    const selection = useSessionListSelectionState();
    const activeData = useSessionListViewData();
    const byServerId = useServerScopedSessionListCache();

    const source = React.useMemo(() => resolveSessionListSourceData({
        enabled: selection.enabled,
        activeServerId: selection.activeServerId,
        activeData,
        byServerId,
        selectedServerIds: selection.allowedServerIds,
    }), [
        activeData,
        byServerId,
        selection.activeServerId,
        selection.allowedServerIds,
        selection.enabled,
    ]);

    return React.useMemo(() => ({
        selection,
        activeData,
        byServerId,
        source,
    }), [
        activeData,
        byServerId,
        selection,
        source,
    ]);
}
