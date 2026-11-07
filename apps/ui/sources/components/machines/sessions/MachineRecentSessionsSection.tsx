import * as React from 'react';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { useMachineRecentSessions } from '@/sync/store/sessionListMachineRecent';
import { t } from '@/text';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

/** The five most recent sessions on this machine (Project work); absent when it has none. */
export const MachineRecentSessionsSection = React.memo(function MachineRecentSessionsSection(props: Readonly<{
    machineId: string;
    serverId: string;
}>) {
    const navigateToSession = useNavigateToSession();
    const presented = useLayoutPresentationActive();
    const isSessionVisible = useSessionRecordingVisibility(presented);
    const recent = useMachineRecentSessions(props.serverId, props.machineId, isSessionVisible, presented);

    if (recent.length === 0) return null;
    return (
        <ItemGroup title={t('machineDetailPage.recentSessionsTitle')} description={t('machineDetailPage.recentSessionsDescription')}>
            {recent.map((session) => (
                <Item
                    key={session.id}
                    title={getSessionName(session, props.serverId)}
                    icon={<Icon name="chat-circle-dots" />}
                    subtitle={getSessionSubtitle(session, props.serverId)}
                    onPress={() => navigateToSession(session.id, { serverId: props.serverId })}
                    showChevron
                />
            ))}
        </ItemGroup>
    );
});
