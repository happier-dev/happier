import * as React from 'react';

import { useSessionListSelectionState } from './useSessionListSelectionState';
import { useSessionListIndexByServerId } from '@/sync/domains/state/storage';
import {
    readSessionListIndexForServerId,
    resolveSessionListSourceIndex,
} from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListAgentTargetDemand } from '@/sync/domains/session/listing/useSessionListAgentTargetDemand';
import {
    useSessionListQuerySourceState,
    type SessionListQueryHomeInput,
    type SessionListQuerySourceState,
} from '@/sync/domains/session/listing/useSessionListQuerySourceState';

export type VisibleSessionListSourceStateOptions = Readonly<{
    /** Presence selects the structural query corpus; an empty array means an intentionally empty Home selection. */
    queryHomes?: readonly SessionListQueryHomeInput[];
    /** Distinguishes a proved empty qualified selection from startup before Home discovery. */
    emptyQuerySelectionComplete?: boolean;
    /** A local Agent condition needs its private target fact, not another structural corpus. */
    agentTargetDemand?: boolean;
}>;

export type VisibleSessionListSourceState = Readonly<{
    selection: ReturnType<typeof useSessionListSelectionState>;
    activeIndex: ReadonlyArray<SessionListIndexItem> | null;
    byServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    source: ReadonlyArray<SessionListIndexItem> | null;
    ordinarySourceIndex: ReadonlyArray<SessionListIndexItem> | null;
    query: SessionListQuerySourceState & Readonly<{ active: boolean }>;
}>;

export function useVisibleSessionListSourceState(
    options: VisibleSessionListSourceStateOptions = {},
): VisibleSessionListSourceState {
    const selection = useSessionListSelectionState();
    const queryActive = options.queryHomes !== undefined;
    const querySource = useSessionListQuerySourceState({
        enabled: queryActive,
        homes: options.queryHomes ?? [],
        emptySelectionComplete: options.emptyQuerySelectionComplete === true,
        agentTargetDemand: options.agentTargetDemand === true,
    });
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
    useSessionListAgentTargetDemand(selectedServerIds, !queryActive && options.agentTargetDemand === true);
    const byServerId = useSessionListIndexByServerId(selectedServerIds);
    const ordinaryActiveIndex = React.useMemo(() => {
        const activeServerId = String(selection.activeServerId ?? '').trim();
        if (!activeServerId) return null;
        const index = readSessionListIndexForServerId(byServerId, activeServerId) ?? null;
        return Array.isArray(index) ? index : null;
    }, [byServerId, selection.activeServerId]);

    const ordinarySource = React.useMemo(() => resolveSessionListSourceIndex({
        enabled: selection.enabled,
        activeServerId: selection.activeServerId,
        activeIndex: ordinaryActiveIndex,
        byServerId,
        selectedServerIds: selection.allowedServerIds,
    }), [
        ordinaryActiveIndex,
        byServerId,
        selection.activeServerId,
        selection.allowedServerIds,
        selection.enabled,
    ]);

    const activeIndex = queryActive
        ? (() => {
            const activeServerId = String(selection.activeServerId ?? '').trim();
            const index = activeServerId ? querySource.byServerId[activeServerId] : null;
            return Array.isArray(index) ? index : null;
        })()
        : ordinaryActiveIndex;
    const source = queryActive ? querySource.source : ordinarySource;
    const effectiveByServerId = queryActive ? querySource.byServerId : byServerId;
    const query = React.useMemo(() => ({
        ...querySource,
        active: queryActive,
    }), [queryActive, querySource]);

    return React.useMemo(() => ({
        selection,
        activeIndex,
        byServerId: effectiveByServerId,
        source,
        ordinarySourceIndex: ordinarySource,
        query,
    }), [
        activeIndex,
        effectiveByServerId,
        query,
        selection,
        source,
        ordinarySource,
    ]);
}
