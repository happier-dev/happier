import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSessionListViewDataByServerId, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { computeVisibleSessionListViewData } from '@/sync/domains/session/listing/computeVisibleSessionListViewData';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const activeData = useSessionListViewData();
    const dataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const pinnedSessionKeysV1 = useSetting('pinnedSessionKeysV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const selection = useResolvedActiveServerSelection();

    const source = React.useMemo(() => {
        const source = resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
        return source;
    }, [
        activeData,
        dataByServerId,
        selection,
    ]);

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        return normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [pinnedSessionKeysV1, sessionListGroupOrderV1, source]);

    React.useEffect(() => {
        if (!source) return;
        if (areSessionListGroupOrderMapsEqual(sessionListGroupOrderV1, normalizedGroupOrder)) {
            return;
        }
        setSessionListGroupOrderV1(normalizedGroupOrder);
    }, [normalizedGroupOrder, sessionListGroupOrderV1, setSessionListGroupOrderV1, source]);

    return React.useMemo(() => {
        if (!source) return source;
        return computeVisibleSessionListViewData({
            source,
            hideInactiveSessions,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: normalizedGroupOrder,
            presentation: {
                enabled: selection.enabled,
                presentation: selection.presentation,
                selectedServerIds: selection.allowedServerIds,
            },
        });
    }, [
        hideInactiveSessions,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        selection,
        source,
    ]);
}
