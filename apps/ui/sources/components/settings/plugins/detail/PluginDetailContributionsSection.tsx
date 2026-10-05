import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export function PluginDetailContributionsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
}>) {
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
                    showChevron={false}
                    mode="info"
                />
            ))}
            {resources.map((resource) => (
                <Item
                    key={resource.id}
                    testID={`settings.plugins.detail.${props.pluginId}.contribution.resource.${resource.id}`}
                    title={resource.path ?? resource.id}
                    subtitle={[
                        resource.resourceKind,
                        resource.contentType,
                        resource.digest,
                    ].filter((entry): entry is string => Boolean(entry)).join(' | ')}
                    showChevron={false}
                    mode="info"
                />
            ))}
        </ItemGroup>
    );
}
