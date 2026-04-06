import * as React from 'react';

import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { computeVisibleSessionListViewData } from '@/sync/domains/session/listing/computeVisibleSessionListViewData';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListViewDataByStorageKind } from '@/sync/domains/session/listing/filterSessionListViewDataByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListViewData: SessionListViewItem[] | null;
}>;

export function useVisibleSessionListViewState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListViewState {
    const { selection, source } = useVisibleSessionListSourceState();
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
        return normalizeSessionListGroupOrderV1ForSource({
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

    const visibleSessionListViewData = React.useMemo(() => {
        if (!source) return source;
        const visible = computeVisibleSessionListViewData({
            source,
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
        return filterSessionListViewDataByStorageKind(visible, storageFilter);
    }, [
        hideInactiveSessions,
        selection.allowedServerIds,
        selection.enabled,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        selection.presentation,
        sessionListGroupOrderV1,
        source,
        storageFilter,
        sessionListOrderingModeV1,
    ]);

    return React.useMemo(() => ({
        visibleSessionListViewData,
    }), [visibleSessionListViewData]);
}
