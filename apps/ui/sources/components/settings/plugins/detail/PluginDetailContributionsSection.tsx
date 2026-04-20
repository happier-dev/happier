import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export function PluginDetailContributionsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
}>) {
    const { theme } = useUnistyles();
    const actions = props.projection?.actions ?? [];
    const resources = props.projection?.resources ?? [];

    if (actions.length === 0 && resources.length === 0) {
        return null;
    }

    return (
        <ItemGroup title={t('settingsPlugins.contributionsTitle')}>
            {actions.map((action) => (
                <Item
                    key={action.id}
                    testID={`settings.plugins.detail.${props.pluginId}.contribution.action.${action.id}`}
                    title={action.title}
                    subtitle={action.description ?? action.placement}
                    icon={<Ionicons name="flash-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    mode="info"
                />
            ))}
            {resources.map((resource) => (
                <Item
                    key={resource.id}
                    testID={`settings.plugins.detail.${props.pluginId}.contribution.resource.${resource.id}`}
                    title={resource.path}
                    subtitle={[
                        resource.resourceKind,
                        resource.contentType,
                        resource.digest,
                    ].filter((entry): entry is string => Boolean(entry)).join(' | ')}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    mode="info"
                />
            ))}
        </ItemGroup>
    );
}
