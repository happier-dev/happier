import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { useDescribeRoleRow } from '@/components/roles/catalog/rolePresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { newRoleRoute, resolveRoleCollectionSelection, roleDraftTitle, roleRoute } from './roleCollectionRoutes';
import { RoleCollectionRow } from './RoleCollectionRow';

/** The roles migrated from 0.2 sub-agents guidance, named once under the list (lab `settings-R3`). */
export function readMigratedRoleNames(entries: ReadonlyArray<RoleCatalogEntry>): readonly string[] {
    return entries.filter((entry) => entry.migratedFromV0_2).map((entry) => entry.role.name);
}

/** A new role starts as a session role with no engine of its own, and is marked as one. */
const DRAFT_ROLE_MARK = { runsAs: { kind: 'session' } } as const;

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

export function openRoleCollectionHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

type RoleGroup = Readonly<{ id: RoleCatalogEntry['source']; title: string; entries: ReadonlyArray<RoleCatalogEntry> }>;

/** Built-in, yours, shared with you and from plugins, in that order; empty groups drop out. */
export function groupRoleCatalog(entries: ReadonlyArray<RoleCatalogEntry>, query: string): ReadonlyArray<RoleGroup> {
    const needle = query.trim().toLowerCase();
    const matches = (entry: RoleCatalogEntry) => !needle || entry.role.name.toLowerCase().includes(needle);
    const groups: RoleGroup[] = [
        { id: 'built_in', title: t('roles.settings.groupBuiltIn'), entries: [] },
        { id: 'user', title: t('roles.settings.groupYours'), entries: [] },
        { id: 'shared', title: t('roles.settings.groupShared'), entries: [] },
        { id: 'plugin', title: t('roles.settings.groupPlugins'), entries: [] },
    ];
    return groups
        .map((group) => ({ ...group, entries: entries.filter((entry) => entry.source === group.id && matches(entry)) }))
        .filter((group) => group.entries.length > 0);
}

/**
 * The rail beside a role's detail. Selection comes from the route; the draft of a new role sits on
 * top while its editor is open, and a note explains roles migrated from 0.2 sub-agents guidance.
 */
export const RoleCollectionRail = React.memo(function RoleCollectionRail() {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const selection = resolveRoleCollectionSelection(pathname);
    const catalog = useRoleCatalog();
    const roleMark = useRoleMark();
    const describe = useDescribeRoleRow();
    const [query, setQuery] = React.useState('');
    const searchable = catalog.entries.length > SEARCH_THRESHOLD;
    const groups = groupRoleCatalog(catalog.entries, searchable ? query : '');
    const migratedNames = readMigratedRoleNames(catalog.entries);
    const selectedRoleId = selection.kind === 'role' ? selection.roleId : null;

    return (
        <CollectionList
            testID="settings.roles.rail"
            count={catalog.status === 'ready' ? catalog.entries.length : undefined}
            headerAction={(
                <IconButton
                    testID="settings.roles.rail.add"
                    iconName="plus"
                    accessibilityLabel={t('roles.settings.newRole')}
                    tooltip={t('roles.settings.newRole')}
                    variant="plain"
                    onPress={() => openRoleCollectionHref(router, newRoleRoute(), selection.kind !== 'none', 'RoleCollectionRail.add')}
                />
            )}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('roles.rail.searchPlaceholder'),
                testID: 'settings.roles.rail.search',
            } : null}
        >
            {selection.kind === 'draft' ? (
                <CollectionDraftRow
                    testID="settings.roles.rail.draft"
                    titles={roleDraftTitle}
                    placeholder={t('roles.settings.newRoleName')}
                    mark={(
                        <HappierCollectionListMark>
                            {roleMark(DRAFT_ROLE_MARK, 20)}
                        </HappierCollectionListMark>
                    )}
                />
            ) : null}
            {groups.length === 0 ? (
                <Item
                    testID="settings.roles.rail.empty"
                    title={catalog.status === 'loading' ? t('common.loading') : catalog.status === 'failed'
                        ? t('roles.settings.loadFailed')
                        : searchable && query.trim() ? t('common.noMatches') : t('roles.rail.empty')}
                    density="compact"
                    showChevron={false}
                    mode="info"
                />
            ) : groups.map((group, index) => (
                <React.Fragment key={group.id}>
                    <CollectionListGroupLabel
                        title={group.title}
                        count={group.entries.length}
                        first={index === 0 && selection.kind !== 'draft'}
                    />
                    {group.entries.map((entry) => (
                        <RoleCollectionRow
                            key={entry.roleId}
                            testID={`settings.roles.row.${entry.roleId}`}
                            presentation="rail"
                            entry={entry}
                            mark={roleMark(entry.role, 20, entry.roleId)}
                            facts={describe(entry)}
                            selected={selectedRoleId === entry.roleId}
                            onPress={() => openRoleCollectionHref(
                                router,
                                roleRoute(entry.roleId),
                                selection.kind !== 'none',
                                'RoleCollectionRail.open',
                            )}
                        />
                    ))}
                </React.Fragment>
            ))}
            {migratedNames.length > 0 ? (
                <Item
                    testID="settings.roles.rail.migratedNote"
                    title={t('roles.settings.migratedNote', { names: migratedNames })}
                    titleLines={0}
                    density="compact"
                    showChevron={false}
                    mode="info"
                />
            ) : null}
        </CollectionList>
    );
});
