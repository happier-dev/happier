import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useServerRetentionPolicy } from '@/hooks/server/useServerRetentionPolicy';
import { formatServerRetentionRows, formatSessionRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { normalizeServerRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { t } from '@/text';

type ServerRetentionSectionProps = Readonly<{
    serverId: string | null;
}>;

export function ServerRetentionSection(props: ServerRetentionSectionProps) {
    const { theme } = useUnistyles();
    const policy = useServerRetentionPolicy(props.serverId);
    const rows = React.useMemo(() => formatServerRetentionRows(policy), [policy]);
    const view = React.useMemo(() => policy ? normalizeServerRetentionPolicy(policy) : null, [policy]);
    const finiteDomainIds = React.useMemo(() => new Set(
        view?.domains
            .filter((domain) => view.enabled && domain.policy.mode !== 'keep_forever')
            .map((domain) => domain.id) ?? [],
    ), [view]);

    if (!props.serverId || !policy || !view) {
        return null;
    }

    const summary = formatSessionRetentionSummary(view) ?? t('server.retention.keepForever');

    return (
        <ItemGroup title={t('server.retention.title')}>
            <Item
                testID="server-retention-summary"
                title={summary}
                icon={<Icon name="clock-counter-clockwise" color={theme.colors.text.secondary} />}
                mode="info"
                showChevron={false}
            />
            {finiteDomainIds.size > 0
                ? rows
                    .filter((row) => finiteDomainIds.has(row.key))
                    .map((row) => (
                        <Item
                            key={row.key}
                            testID={`server-retention-row-${row.key}`}
                            title={row.title}
                            subtitle={row.detail}
                            mode="info"
                            showChevron={false}
                        />
                    ))
                : null}
        </ItemGroup>
    );
}
