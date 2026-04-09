import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListLookupSessionServerId } from '@/sync/domains/session/listing/sessionListLookupState';
import { t } from '@/text';

type SessionRetentionNoticeProps = Readonly<{
    sessionId: string;
}>;

export function SessionRetentionNotice(props: SessionRetentionNoticeProps) {
    const serverId = resolveSessionListLookupSessionServerId(storage.getState(), props.sessionId);
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
