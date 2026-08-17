import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type SettingsCatalogOverviewGroupProps = Readonly<{
    /** Stable group identity from the one resolved Settings catalog. */
    groupId: string;
    router: ReturnType<typeof useRouter>;
    theme: ReturnType<typeof useUnistyles>['theme'];
    /** Preserves host-owned navigation details such as blur-on-web behavior. */
    onNavigate?: (route: string) => void | Promise<void>;
    /** Non-page controls may share the group presentation without becoming catalog entries. */
    append?: React.ReactNode;
    /** Page identity/order/admission stay catalog-owned; only dynamic copy may vary by host state. */
    resolveSubtitle?: (
        page: ResolvedSettingsPageNode,
        defaultSubtitle: React.ReactNode | undefined,
    ) => React.ReactNode | undefined;
}>;

const LEGACY_ROW_TEST_IDS: Readonly<Partial<Record<string, string>>> = Object.freeze({
    desktop: 'settings-desktop-entry',
    externalSessions: 'settings-external-sessions-item',
    mcp: 'settings-mcp-servers-item',
    pets: 'settings-pets-row',
    plugins: 'settings-plugin-marketplace-item',
    systemStatus: 'settings-system-status-item',
});

function readTitle(node: ResolvedSettingsPageNode): string {
    return node.title ?? (node.titleKey ? t(node.titleKey) : node.id);
}

function readSubtitle(node: ResolvedSettingsPageNode): string | undefined {
    return node.subtitle ?? (node.subtitleKey ? t(node.subtitleKey) : undefined);
}

/**
 * Resolve exactly one top-level Settings group from the host-owned catalog.
 * Overview presentation consumes its direct destination rows; nested route
 * detail remains reachable through the same catalog/search/route owner rather
 * than becoming a second overview list.
 */
export function resolveSettingsCatalogOverviewGroup(
    tree: readonly ResolvedSettingsPageNode[],
    groupId: string,
): ResolvedSettingsPageNode | null {
    const root = tree.find((node) => node.id === 'settings') ?? null;
    return root?.children?.find((node) => node.id === groupId) ?? null;
}

function testIdForPage(page: ResolvedSettingsPageNode): string {
    if (page.pluginSettingsPage) return `settings-plugin-page-item.${page.id}`;
    return LEGACY_ROW_TEST_IDS[page.id] ?? `settings-catalog-page-item.${page.id}`;
}

/**
 * One Settings-overview consumer for each catalog group. It does not select,
 * gate, order, or synthesize page destinations: those decisions already belong
 * to `useResolvedSettingsPageCatalog`.
 */
export const SettingsCatalogOverviewGroup = React.memo(function SettingsCatalogOverviewGroup({
    append,
    groupId,
    onNavigate,
    resolveSubtitle,
    router,
    theme,
}: SettingsCatalogOverviewGroupProps) {
    const catalog = useResolvedSettingsPageCatalog();
    const group = React.useMemo(
        () => resolveSettingsCatalogOverviewGroup(catalog.tree, groupId),
        [catalog.tree, groupId],
    );
    const pages = React.useMemo(
        () => (group?.children ?? []).filter((page) => typeof page.route === 'string' && page.route.length > 0),
        [group],
    );

    if (!group || (pages.length === 0 && !append)) return null;

    return (
        <ItemGroup title={readTitle(group)}>
            {pages.map((page) => {
                const defaultSubtitle = readSubtitle(page);
                const subtitle = resolveSubtitle
                    ? resolveSubtitle(page, defaultSubtitle)
                    : defaultSubtitle;
                const route = page.route!;
                return (
                    <Item
                        key={page.id}
                        testID={testIdForPage(page)}
                        title={readTitle(page)}
                        subtitle={subtitle}
                        icon={page.icon?.({ theme })}
                        onPress={() => {
                            if (onNavigate) {
                                void onNavigate(route);
                                return;
                            }
                            router.push(route as never);
                        }}
                    />
                );
            })}
            {append}
        </ItemGroup>
    );
});

export const __testables = { resolveSettingsCatalogOverviewGroup };
