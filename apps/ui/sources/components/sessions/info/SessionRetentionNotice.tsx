import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';

type SessionRetentionNoticeProps = Readonly<{
    sessionId: string;
}>;

export function SessionRetentionNotice(props: SessionRetentionNoticeProps) {
    const serverId = React.useMemo(() => resolveServerIdForSessionIdFromLocalCache(props.sessionId), [props.sessionId]);
    const policy = useServerRetentionPolicy(serverId);

    if (!serverId || !policy || !policy.enabled || policy.sessions.mode === 'keep_forever') {
        return null;
    }

    return (
        <ItemGroup title={t('server.retention.title')}>
            <Item
                testID="session-retention-notice"
                title={t('server.retention.sessions')}
                subtitle={formatSessionRetentionSummary(policy) ?? t('server.retention.keepForever')}
                showChevron={false}
            />
        </ItemGroup>
    );
}
