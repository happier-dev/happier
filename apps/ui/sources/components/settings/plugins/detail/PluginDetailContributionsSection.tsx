import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

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
                    subtitle={action.description ?? (
                        action.placementBindings.length > 0
                            ? action.placementBindings.join(', ')
                            : null
                    )}
                    icon={<Icon name="lightning" size={29} color={theme.colors.text.secondary} />}
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
                    icon={<Icon name="file-text" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            ))}
        </ItemGroup>
    );
}
