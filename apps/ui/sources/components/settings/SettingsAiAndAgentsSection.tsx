import * as React from 'react';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type SettingsAiAndAgentsSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'router'
    | 'theme'
>>;

function findAiAndAgentsPages(tree: readonly ResolvedSettingsPageNode[]): readonly ResolvedSettingsPageNode[] {
    for (const node of tree) {
        if (node.id === 'groupAiAndAgents') return node.children ?? [];
        if (node.children) {
            const pages = findAiAndAgentsPages(node.children);
            if (pages.length > 0) return pages;
        }
    }
    return [];
}

export const SettingsAiAndAgentsSection = React.memo(function SettingsAiAndAgentsSection({
    router,
    theme,
}: SettingsAiAndAgentsSectionProps) {
    const resolvedCatalog = useResolvedSettingsPageCatalog();
    const pages = React.useMemo(() => findAiAndAgentsPages(resolvedCatalog.tree), [resolvedCatalog.tree]);

    if (pages.length === 0) return null;

    return (
        <ItemGroup title={t('settings.aiAndAgents')}>
            {pages.map((page) => page.route ? (
                <Item
                    key={page.id}
                    testID={page.id === 'mcp' ? 'settings-mcp-servers-item'
                        : page.id === 'plugins' ? 'settings-plugin-marketplace-item'
                            : undefined}
                    title={t(page.titleKey)}
                    subtitle={page.subtitleKey ? t(page.subtitleKey) : undefined}
                    icon={page.icon?.({ theme })}
                    onPress={() => router.push(page.route as never)}
                />
            ) : null)}
        </ItemGroup>
    );
});

export const __testables = { findAiAndAgentsPages };
