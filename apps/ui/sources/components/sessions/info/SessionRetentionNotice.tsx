import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { normalizeServerRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListLookupSessionServerId } from '@/sync/domains/session/listing/sessionListLookupState';
import { t } from '@/text';

type SessionRetentionNoticeProps = Readonly<{
    sessionId: string;
}>;

export function SessionRetentionNotice(props: SessionRetentionNoticeProps) {
    const { theme } = useUnistyles();
    const serverId = resolveSessionListLookupSessionServerId(storage.getState(), props.sessionId);
    const policy = useServerRetentionPolicy(serverId);
    const sessionsPolicy = policy
        ? normalizeServerRetentionPolicy(policy).domains.find((domain) => domain.id === 'sessions')?.policy
        : null;

    if (!serverId || !policy || sessionsPolicy?.mode !== 'delete_inactive') {
        return null;
    }

    return (
        <ItemGroup title={t('server.retention.title')}>
            <Item
                testID="session-retention-notice"
                title={t('server.retention.sessions')}
                subtitle={formatSessionRetentionSummary(policy) ?? t('server.retention.keepForever')}
                icon={(
                    <Icon
                        testID="session-retention-notice-icon"
                        name="clock-counter-clockwise"
                        color={theme.colors.text.secondary}
                    />
                )}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
}
