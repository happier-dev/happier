import * as React from 'react';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { resolveHappierCollectionInitialKey, useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { groupRoleCatalog, openRoleCollectionHref, readMigratedRoleNames } from './RoleCollectionRail';
import { RoleCollectionRow } from './RoleCollectionRow';
import { useDescribeRoleRow } from '@/components/roles/catalog/rolePresentation';
import { newRoleRoute, readLastVisitedRoleId, roleRoute } from './roleCollectionRoutes';

/**
 * `/settings/roles`. Beside the rail a role is always selected, so the index lands on one. Where no
 * rail shows, the index is the role list and each role pushes its detail.
 */
export const RoleSettingsIndex = React.memo(function RoleSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <RoleCollectionLanding />;
    return <RoleCollectionPage />;
});

const RoleCollectionLanding = React.memo(function RoleCollectionLanding() {
    const router = useRouter();
    const catalog = useRoleCatalog();
    const landingId = resolveHappierCollectionInitialKey({
        keys: catalog.entries.map((entry) => entry.roleId),
        lastVisited: readLastVisitedRoleId(),
    });
    if (!landingId) {
        return (
            <ItemList>
                <SurfaceStateCard
                    testID="settings.roles.landing"
                    kind={catalog.status === 'ready' ? 'empty' : catalog.status === 'failed' ? 'error' : 'loading'}
                    title={catalog.status === 'ready' ? t('roles.rail.empty')
                        : catalog.status === 'failed' ? t('roles.settings.loadFailed') : t('common.loading')}
                    reason={catalog.status === 'ready' ? t('roles.settings.description') : undefined}
                    action={catalog.status === 'ready' ? {
                        label: t('roles.settings.newRole'),
                        onPress: () => openRoleCollectionHref(router, newRoleRoute(), false, 'RoleCollectionLanding.add'),
                    } : catalog.status === 'failed' ? { label: t('common.retry'), onPress: catalog.refresh } : undefined}
                />
            </ItemList>
        );
    }
    return <Redirect href={roleRoute(landingId) as never} />;
});

const RoleCollectionPage = React.memo(function RoleCollectionPage() {
    const phone = useDeviceType() === 'phone';
    const router = useRouter();
    const { theme } = useUnistyles();
    const catalog = useRoleCatalog();
    const roleMark = useRoleMark();
    const describe = useDescribeRoleRow();
    const groups = groupRoleCatalog(catalog.entries, '');
    const migratedNames = readMigratedRoleNames(catalog.entries);
    return (
        <ItemList testID="settings.roles.page">
            {phone ? <SettingsPageHeader description={t('roles.settings.description')} /> : null}
            {groups.map((group) => (
                <ItemGroup key={group.id} title={group.title}>
                    {group.entries.map((entry) => (
                        <RoleCollectionRow
                            key={entry.roleId}
                            testID={`settings.roles.page.row.${entry.roleId}`}
                            presentation="page"
                            entry={entry}
                            mark={roleMark(entry.role, 20, entry.roleId)}
                            facts={describe(entry)}
                            onPress={() => openRoleCollectionHref(router, roleRoute(entry.roleId), false, 'RoleCollectionPage.open')}
                        />
                    ))}
                </ItemGroup>
            ))}
            {migratedNames.length > 0 ? (
                <Item
                    testID="settings.roles.page.migratedNote"
                    title={t('roles.settings.migratedNote', { names: migratedNames })}
                    titleLines={0}
                    showChevron={false}
                    mode="info"
                />
            ) : null}
            {catalog.status !== 'ready' && groups.length === 0 ? (
                <SurfaceStateCard
                    testID={catalog.status === 'loading' ? 'settings.roles.page.loading' : 'settings.roles.page.failed'}
                    kind={catalog.status === 'loading' ? 'loading' : 'error'}
                    title={catalog.status === 'loading' ? t('common.loading') : t('roles.settings.loadFailed')}
                    action={catalog.status === 'failed' ? { label: t('common.retry'), onPress: catalog.refresh } : undefined}
                />
            ) : null}
            <ItemGroup>
                <Item
                    testID="settings.roles.page.add"
                    title={t('roles.settings.newRole')}
                    icon={<Icon name="plus" size={16} color={theme.colors.text.secondary} />}
                    onPress={() => openRoleCollectionHref(router, newRoleRoute(), false, 'RoleCollectionPage.add')}
                />
            </ItemGroup>
        </ItemList>
    );
});
