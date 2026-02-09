import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSessionListViewDataByServerId, useSetting } from '@/sync/domains/state/storage';
import { applySessionListPresentation, resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { getEffectiveServerSelection } from '@/sync/domains/server/multiServer';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const activeData = useSessionListViewData();
    const dataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const settingsMultiServerEnabled = useSetting('multiServerEnabled');
    const settingsMultiServerSelectedServerIds = useSetting('multiServerSelectedServerIds');
    const settingsMultiServerPresentation = useSetting('multiServerPresentation');
    const settingsMultiServerProfiles = useSetting('multiServerProfiles');
    const settingsMultiServerActiveProfileId = useSetting('multiServerActiveProfileId');

    return React.useMemo(() => {
        const availableServerIds = listServerProfiles().map((profile) => profile.id);
        const activeServerId = getActiveServerSnapshot().serverId;
        const selection = getEffectiveServerSelection({
            activeServerId,
            availableServerIds,
            settings: {
                multiServerEnabled: settingsMultiServerEnabled,
                multiServerSelectedServerIds: settingsMultiServerSelectedServerIds,
                multiServerPresentation: settingsMultiServerPresentation,
                multiServerProfiles: settingsMultiServerProfiles,
                multiServerActiveProfileId: settingsMultiServerActiveProfileId,
            },
        });

        const source = resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.serverIds,
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
            selectedServerIds: selection.serverIds,
        });
    }, [
        activeData,
        dataByServerId,
        hideInactiveSessions,
        settingsMultiServerEnabled,
        settingsMultiServerActiveProfileId,
        settingsMultiServerProfiles,
        settingsMultiServerSelectedServerIds,
        settingsMultiServerPresentation,
    ]);
}
