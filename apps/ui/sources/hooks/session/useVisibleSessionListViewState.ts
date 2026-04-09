import * as React from 'react';

import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSessionListRowStateByServerId } from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: SessionListIndexItem[] | null;
}>;

export function useVisibleSessionListViewState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListViewState {
    const { selection, source } = useVisibleSessionListSourceState();
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const pinnedSessionKeysV1 = useSetting('pinnedSessionKeysV1');
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');

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
        const resolveSessionRow = (serverId: string | null | undefined, sessionId: string) => {
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
        };

        const visible = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: sessionListOrderingModeV1 === 'custom' ? normalizedGroupOrder : sessionListGroupOrderV1,
            sessionListOrderingModeV1,
            presentation: {
                enabled: selection.enabled,
                presentation: selection.presentation,
                selectedServerIds: selection.allowedServerIds,
            },
        });
        if (!visible || storageFilter === 'all') return visible;
        return filterSessionListIndexByStorageKind(visible, storageFilter);
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

    return React.useMemo(() => ({
        visibleSessionListIndex,
    }), [visibleSessionListIndex]);
}
