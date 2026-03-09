import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatServerRetentionRows, formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { hasFiniteRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { t } from '@/text';

type ServerRetentionSectionProps = Readonly<{
    serverId: string | null;
}>;

export function ServerRetentionSection(props: ServerRetentionSectionProps) {
    const policy = useServerRetentionPolicy(props.serverId);
    const rows = React.useMemo(() => formatServerRetentionRows(policy), [policy]);

    if (!props.serverId || !policy) {
        return null;
    }

    return (
        <ItemGroup title={t('server.retention.title')}>
            <Item
                testID="server-retention-summary"
                title={t('server.retention.summary')}
                subtitle={formatSessionRetentionSummary(policy) ?? t('server.retention.keepForever')}
                showChevron={false}
            />
            {hasFiniteRetentionPolicy(policy)
                ? rows
                    .filter((row) => row.detail !== t('server.retention.keepForever'))
                    .map((row) => (
                        <Item
                            key={row.key}
                            testID={`server-retention-row-${row.key}`}
                            title={row.title}
                            subtitle={row.detail}
                            showChevron={false}
                        />
                    ))
                : null}
        </ItemGroup>
    );
}
