import * as React from 'react';

import { useSessionListSelectionState } from './useSessionListSelectionState';
import { useSessionListIndexByServerId } from '@/sync/domains/state/storage';
import { resolveSessionListSourceIndex } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type VisibleSessionListSourceState = Readonly<{
    selection: ReturnType<typeof useSessionListSelectionState>;
    activeIndex: ReadonlyArray<SessionListIndexItem> | null;
    byServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    source: ReadonlyArray<SessionListIndexItem> | null;
}>;

export function useVisibleSessionListSourceState(): VisibleSessionListSourceState {
    const selection = useSessionListSelectionState();
    const selectedServerIds = React.useMemo(
        () => {
            if (selection.enabled) {
                return selection.allowedServerIds;
            }
            const allowedServerIds = selection.allowedServerIds
                .map((serverId) => String(serverId).trim())
                .filter((serverId) => serverId.length > 0);
            if (allowedServerIds.length > 0) {
                return allowedServerIds;
            }
            const activeServerId = String(selection.activeServerId ?? '').trim();
            return activeServerId ? [activeServerId] : [];
        },
        [selection.activeServerId, selection.allowedServerIds, selection.enabled],
    );
    const byServerId = useSessionListIndexByServerId(selectedServerIds);
    const activeIndex = React.useMemo(() => {
        const activeServerId = String(selection.activeServerId ?? '').trim();
        if (!activeServerId) return null;
        const index = byServerId[activeServerId] ?? null;
        return Array.isArray(index) ? index : null;
    }, [byServerId, selection.activeServerId]);

    const source = React.useMemo(() => resolveSessionListSourceIndex({
        enabled: selection.enabled,
        activeServerId: selection.activeServerId,
        activeIndex,
        byServerId,
        selectedServerIds: selection.allowedServerIds,
    }), [
        activeIndex,
        byServerId,
        selection.activeServerId,
        selection.allowedServerIds,
        selection.enabled,
    ]);

    return React.useMemo(() => ({
        selection,
        activeIndex,
        byServerId,
        source,
    }), [
        activeIndex,
        byServerId,
        selection,
        source,
    ]);
}
