import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSessionListViewDataByServerId, useSetting } from '@/sync/domains/state/storage';
import { applySessionListPresentation, resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const activeData = useSessionListViewData();
    const dataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const selection = useResolvedActiveServerSelection();

    return React.useMemo(() => {
        const source = resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
        if (!source) {
            return source;
        }

        let visible = source;

        if (hideInactiveSessions) {
            const filtered: SessionListViewItem[] = [];
            let pendingProjectGroup: SessionListViewItem | null = null;

            for (const item of source) {
                if (item.type === 'project-group') {
                    pendingProjectGroup = item;
                    continue;
                }

                if (item.type === 'session') {
                    if (item.session.active) {
                        if (pendingProjectGroup) {
                            filtered.push(pendingProjectGroup);
                            pendingProjectGroup = null;
                        }
                        filtered.push(item);
                    }
                    continue;
                }

                pendingProjectGroup = null;

                if (item.type === 'active-sessions') {
                    filtered.push(item);
                }
            }

            visible = filtered;
        }

        return applySessionListPresentation(visible, {
            enabled: selection.enabled,
            presentation: selection.presentation,
            selectedServerIds: selection.allowedServerIds,
        });
    }, [
        activeData,
        dataByServerId,
        hideInactiveSessions,
        selection,
    ]);
}
