import * as React from 'react';
import { Platform, View } from 'react-native';
import { usePathname, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HomeMark } from '@/components/homes/HomeMark';
import { OrganizationPolicyFieldNotice, readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { homeAdministrationOverviewPath, homeAdministrationRuntimePath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { buildHomeRecoveryHref } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { HomeDeviceApprovalSection } from '@/components/settings/server/sections/HomeDeviceApprovalSection';
import { resolveCurrentHomeAttention, resolveHomeRowActions, type HomeRowMenuAction } from '@/components/settings/server/sections/homeRowActions';
import { ServerRetentionSection } from '@/components/settings/server/sections/ServerRetentionSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useHomeAdministrationSettingsAdmission } from '@/hooks/home/useHomeAdministrationSettingsAdmission';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isServerProfilePersonalHomeBootstrapCompleted } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { retrySessionListQueryHome } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useHomesCollection } from './HomesCollection';
import { HOMES_COLLECTION_ROOT, type HomeCollectionRow } from './homeCollectionModel';

const MENU_TITLES: Readonly<Record<HomeRowMenuAction, () => string>> = {
    switch: () => t('server.switchToServer'),
    'switch-tab': () => t('server.switchForThisTab'),
    'switch-device': () => t('server.makeDefaultOnDevice'),
    rename: () => t('common.rename'),
    remove: () => t('common.remove'),
};

/**
 * A Home's page in Settings → Homes: which Home it is (its mark, name, address and state), the one
 * action its state needs (use it here, sign in again, retry), its administration when this account may
 * administer it, the devices waiting to join it and its retention. Rarer operations sit in `⋯`.
 */
export const HomeSettingsPage = React.memo(function HomeSettingsPage(props: Readonly<{ homeId: string }>) {
    const { collection } = useHomesCollection();
    const row = collection.homes.find((candidate) => candidate.id === props.homeId || candidate.profile.id === props.homeId) ?? null;
    if (!row) return <HomeSettingsPageMissing />;
    return <HomeSettingsPageContent row={row} />;
});

const HomeSettingsPageMissing = React.memo(function HomeSettingsPageMissing() {
    const router = useRouter();
    return (
        <ItemList>
            <EmptyState
                testID="settings.homes.home.missing"
                iconName="house"
                title={t('addFlows.homeMissingTitle')}
                subtitle={t('addFlows.homeMissingDescription')}
                primaryAction={{ label: t('settings.servers'), onPress: () => router.replace(HOMES_COLLECTION_ROOT as never) }}
            />
        </ItemList>
    );
});

const HomeSettingsPageContent = React.memo(function HomeSettingsPageContent(props: Readonly<{ row: HomeCollectionRow }>) {
    const homePolicy = readOrganizationPolicyFieldState('home');
    const { row } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const { controller } = useHomesCollection();
    const profile = row.profile;
    const homes = React.useMemo(() => [profile], [profile]);
    const serverIds = React.useMemo(() => [row.id], [row.id]);
    const administration = useHomeAdministrationSettingsAdmission({ serverIds });
    const administrable = administration.admittedServerIds.includes(row.id);
    const personalHomeHere = isDesktopHost() && isServerProfilePersonalHomeBootstrapCompleted(profile);

    const { primary, menu } = resolveHomeRowActions({
        isCurrent: row.current,
        isDeviceDefault: row.deviceDefault,
        isUnnamed: resolveHomeDisplayName(profile) === null,
        isWeb: Platform.OS === 'web',
        routineScope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        summaryKind: row.summary.kind,
    });
    const attention = row.current ? resolveCurrentHomeAttention(row.summary) : null;

    const navigate = React.useCallback((href: Href, tag: string, replace = false) => {
        const result = runGuardedNavigation(() => (replace ? router.replace(href) : router.push(href)));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const signIn = React.useCallback(() => {
        navigate(buildHomeRecoveryHref({ profileRef: profile.id, returnTo: pathname }), 'HomeSettingsPage.signIn');
    }, [navigate, pathname, profile.id]);
    const retry = React.useCallback(() => {
        fireAndForget(retrySessionListQueryHome(row.id), { tag: 'HomeSettingsPage.retry' });
    }, [row.id]);

    const runMenu = React.useCallback(async (id: HomeRowMenuAction) => {
        if (id === 'switch') return controller.onSwitchServer(profile);
        if (id === 'switch-tab') return controller.onSwitchServer(profile, 'tab');
        if (id === 'switch-device') return controller.onSwitchServer(profile, 'device');
        if (id === 'rename') return controller.onRenameServer(profile);
        await controller.onRemoveServer(profile);
    }, [controller, profile]);
    const menuActions = React.useMemo((): PageHeaderMenuAction[] => menu.map((id) => ({
        id,
        testID: `settings.homes.home.menu.${id}`,
        title: id === 'rename' && resolveHomeDisplayName(profile) === null ? t('server.homes.nameThisHome') : MENU_TITLES[id](),
        destructive: id === 'remove',
        disabled: homePolicy.disabled && id !== 'rename' && id !== 'remove',
        subtitle: id !== 'rename' && id !== 'remove' ? homePolicy.accessibilityHint : undefined,
        onSelect: () => runMenu(id),
    })), [homePolicy.disabled, homePolicy.accessibilityHint, menu, profile, runMenu]);

    const meta = [
        { key: 'status', text: t(row.summary.statusLabelKey), testID: 'settings.homes.home.status' },
        ...(row.current ? [{ key: 'current', text: t('addFlows.homesInUse') }] : []),
        ...(!row.current && row.deviceDefault ? [{ key: 'default', text: t('homesHub.opensFirst') }] : []),
    ];

    return (
        <ItemList>
            <PageHeader
                testID="settings.homes.home.header"
                alwaysShowTitle
                title={row.title}
                description={toServerUrlDisplay(row.serverUrl)}
                meta={meta}
                leading={<HomeMark serverUrl={row.serverUrl} size="page" />}
                actions={(
                    <View style={styles.headerActions}>
                        {primary ? (
                            <RoundButton
                                testID={`settings.homes.home.${primary}`}
                                disabled={primary === 'switch' && homePolicy.disabled}
                                display={primary === 'switch' ? 'secondary' : undefined}
                                title={primary === 'switch' ? t('server.homes.switch') : primary === 'signIn' ? t('server.homes.signIn') : t('common.retry')}
                                onPress={primary === 'switch' ? () => void controller.onSwitchServer(profile) : primary === 'signIn' ? signIn : retry}
                            />
                        ) : null}
                        <PageHeaderMenu testID="settings.homes.home.menu" actions={menuActions} />
                    </View>
                )}
            />

            <OrganizationPolicyFieldNotice field="home" />
            {attention ? (
                <AttentionBanner
                    testID="settings.homes.home.attention"
                    title={attention === 'signIn'
                        ? t('server.homes.signInAgainTitle', { name: row.title })
                        : t('server.homes.unavailableTitle', { name: row.title })}
                    description={attention === 'signIn'
                        ? t('server.homes.signInAgainDescription')
                        : t('server.homes.unavailableDescription')}
                    action={attention === 'signIn'
                        ? { label: t('connectionStatus.summary.signInAgain'), onPress: signIn }
                        : attention === 'retry'
                            ? { label: t('common.retry'), onPress: retry }
                            : null}
                />
            ) : null}

            {administrable || personalHomeHere ? (
                <ItemGroup title={t('addFlows.homeManageTitle')}>
                    {administrable ? (
                        <Item
                            testID="settings.homes.home.administration"
                            icon={<Icon name="shield" size={20} color={theme.colors.text.secondary} />}
                            title={t('homeGovernance.title')}
                            subtitle={t('addFlows.homeAdministrationSubtitle')}
                            onPress={() => navigate(homeAdministrationOverviewPath(row.id), 'HomeSettingsPage.administration')}
                        />
                    ) : null}
                    {personalHomeHere ? (
                        <Item
                            testID="settings.homes.home.runtime"
                            icon={<Icon name="hard-drives" size={20} color={theme.colors.text.secondary} />}
                            title={t('homeGovernance.runtime.hostedHere', { home: row.title })}
                            subtitle={t('homeGovernance.runtime.hostedHereSubtitle')}
                            onPress={() => navigate(homeAdministrationRuntimePath(row.id), 'HomeSettingsPage.runtime')}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            <HomeDeviceApprovalSection homes={homes} />
            <ServerRetentionSection serverId={row.id} />
        </ItemList>
    );
});

const styles = StyleSheet.create({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
});
