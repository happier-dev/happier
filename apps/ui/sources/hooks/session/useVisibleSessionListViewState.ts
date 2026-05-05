import * as React from 'react';

import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSessionListRowStateByServerId } from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';

type SessionListGroupOrderV1 = Record<string, string[] | undefined>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
}>;

function countSessionItems(index: ReadonlyArray<SessionListIndexItem> | null): number {
    if (!index) return 0;
    let count = 0;
    for (const item of index) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function resolveSessionRowFromState(
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>,
    serverId: string | null | undefined,
    sessionId: string,
) {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedServerId || !normalizedSessionId) {
        return null;
    }
    const scoped = sessionRowStateByServerId?.[normalizedServerId];
    if (!scoped || typeof scoped !== 'object') {
        return null;
    }
    return scoped[normalizedSessionId] ?? null;
}

function buildVisibleSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
    normalizedGroupOrder: SessionListGroupOrderV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    storageFilter: SessionListStorageFilter;
}>): ReadonlyArray<SessionListIndexItem> | null {
    const visible = computeVisibleSessionListIndex({
        source: params.source,
        resolveSessionRow: (serverId, sessionId) => resolveSessionRowFromState(params.sessionRowStateByServerId, serverId, sessionId),
        hideInactiveSessions: params.hideInactiveSessions,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionListOrderingModeV1: params.sessionListOrderingModeV1,
        presentation: {
            enabled: params.selection.enabled,
            presentation: params.selection.presentation,
            selectedServerIds: params.selection.allowedServerIds,
        },
        storageFilterApplied: params.storageFilter !== 'all',
    });
    if (!visible || params.storageFilter === 'all') return visible;
    return filterSessionListIndexByStorageKind(visible, params.storageFilter);
}

export function useVisibleSessionListViewState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListViewState {
    const { selection, source } = useVisibleSessionListSourceState();
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') as boolean | null;
    const pinnedSessionKeysV1 = (useSetting('pinnedSessionKeysV1') ?? []) as PinnedSessionKeysV1;
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1') as [
        SessionListGroupOrderV1,
        (value: SessionListGroupOrderV1) => void,
    ];

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionListGroupOrderV1;
        return normalizeSessionListGroupOrderV1ForIndexSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [pinnedSessionKeysV1, sessionListGroupOrderV1, sessionListOrderingModeV1, source]);

    React.useEffect(() => {
        if (!source) return;
        if (sessionListOrderingModeV1 !== 'custom') return;
        if (areSessionListGroupOrderMapsEqual(sessionListGroupOrderV1, normalizedGroupOrder)) {
            return;
        }
        setSessionListGroupOrderV1(normalizedGroupOrder);
    }, [normalizedGroupOrder, sessionListGroupOrderV1, sessionListOrderingModeV1, setSessionListGroupOrderV1, source]);

    const visibleSessionListIndex = React.useMemo(() => {
        if (!source) return source;
        return buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: hideInactiveSessions === true,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            selection,
            storageFilter,
        });
    }, [
        hideInactiveSessions,
        selection.allowedServerIds,
        selection.enabled,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionRowStateByServerId,
        source,
        storageFilter,
        sessionListOrderingModeV1,
    ]);

    const hasHiddenInactiveSessions = React.useMemo(() => {
        if (!source || !hideInactiveSessions) {
            return false;
        }

        if (countSessionItems(visibleSessionListIndex) > 0) {
            return false;
        }

        const visibleWithoutInactiveFilter = buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: false,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            selection,
            storageFilter,
        });

        return countSessionItems(visibleWithoutInactiveFilter) > 0;
    }, [
        hideInactiveSessions,
        normalizedGroupOrder,
        pinnedSessionKeysV1,
        selection.allowedServerIds,
        selection.enabled,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionListOrderingModeV1,
        sessionRowStateByServerId,
        source,
        storageFilter,
        visibleSessionListIndex,
    ]);

    return React.useMemo(() => ({
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
    }), [hasHiddenInactiveSessions, visibleSessionListIndex]);
}
