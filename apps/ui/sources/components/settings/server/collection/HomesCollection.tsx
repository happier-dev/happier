import * as React from 'react';
import { Platform } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { HomeMark } from '@/components/homes/HomeMark';
import { homeAddDraftTitle } from '@/components/homes/add/homeAddDraftTitle';
import { homeGroupDraftTitle } from './homeGroupDraftTitle';
import { useServerSettingsScreenController } from '@/components/settings/server/hooks/useServerSettingsScreenController';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    CollectionDraftRow,
    CollectionList,
    CollectionListGroupLabel,
    collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    HOMES_ADD_ROUTE,
    HOMES_COLLECTION_ROOT,
    HOMES_DEVICE_ROUTE,
    HOMES_GROUP_NEW_ROUTE,
    buildHomeCollection,
    describeHomeRow,
    homeCollectionHref,
    homeGroupCollectionHref,
    resolveSelectedHomeCollectionKey,
    type HomeCollection,
    type HomeCollectionRow,
} from './homeCollectionModel';

type HomesController = ReturnType<typeof useServerSettingsScreenController>;

type HomesCollectionContextValue = Readonly<{
    controller: HomesController;
    collection: HomeCollection;
}>;

const HomesCollectionContext = React.createContext<HomesCollectionContextValue | null>(null);

/**
 * The one owner of Settings → Homes' data (the Homes this device knows, their connection state,
 * groups and actions), shared by the rail and every page beside it so they read the same answer.
 */
export function HomesCollectionProvider(props: Readonly<{ children: React.ReactNode }>) {
    const controller = useServerSettingsScreenController();
    const collection = React.useMemo(() => buildHomeCollection({
        servers: controller.servers,
        groups: controller.serverGroups,
        activeServerId: controller.activeServerId,
        activeTargetKey: controller.activeTargetKey,
        deviceDefaultServerId: controller.deviceDefaultServerId,
        authStatusByServerId: controller.authStatusByServerId,
        homeConnectionSummaryByServerId: controller.homeConnectionSummaryByServerId,
    }), [
        controller.activeServerId,
        controller.activeTargetKey,
        controller.authStatusByServerId,
        controller.deviceDefaultServerId,
        controller.homeConnectionSummaryByServerId,
        controller.serverGroups,
        controller.servers,
    ]);
    const value = React.useMemo(() => ({ controller, collection }), [collection, controller]);
    return <HomesCollectionContext.Provider value={value}>{props.children}</HomesCollectionContext.Provider>;
}

export function useHomesCollection(): HomesCollectionContextValue {
    const value = React.useContext(HomesCollectionContext);
    if (!value) throw new Error('useHomesCollection must be used inside HomesCollectionProvider');
    return value;
}

function openHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

export { describeHomeRow } from './homeCollectionModel';
/** The collection's "+": add a Home (a draft in the collection) or make a group of Homes. */
export const AddHomesMenu = React.memo(function AddHomesMenu(props: Readonly<{ replace: boolean }>) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => [
        { id: 'home', title: t('addFlows.addHome'), subtitle: t('addFlows.addHomeSubtitle') },
        { id: 'group', title: t('addFlows.newGroup'), subtitle: t('addFlows.newGroupSubtitle') },
    ], []);
    return (
        <DropdownMenu
            testID="settings.homes.addMenu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={(id) => {
                setOpen(false);
                openHref(router, id === 'group' ? HOMES_GROUP_NEW_ROUTE : HOMES_ADD_ROUTE, props.replace, 'AddHomesMenu.select');
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={320}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <IconButton
                    testID="settings.homes.addMenu.trigger"
                    iconName="plus"
                    accessibilityLabel={t('addFlows.addHome')}
                    tooltip={t('addFlows.addHome')}
                    variant="plain"
                    onPress={toggle}
                />
            )}
        />
    );
});

/**
 * Settings → Homes as a collection: this device (how it reaches its Homes), then the Home in use and
 * the other Homes, then groups of Homes. `rail` is the list beside the open page (rows replace it);
 * `page` is the same list where no rail shows (rows push). Selection comes from the route.
 */
export const HomesCollectionList = React.memo(function HomesCollectionList(props: Readonly<{ variant: 'rail' | 'page' }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { collection } = useHomesCollection();
    const rail = props.variant === 'rail';
    const selectedKey = rail ? resolveSelectedHomeCollectionKey(pathname) : null;
    const onDetailRoute = pathname.startsWith(`${HOMES_COLLECTION_ROOT}/`) || (rail && pathname === HOMES_COLLECTION_ROOT);

    const rowProps = (selected: boolean) => ({
        selected: rail ? selected : undefined,
        density: rail ? ('compact' as const) : undefined,
        showChevron: !rail,
        pressableStyle: rail ? collectionListStyles.row : undefined,
    });

    const deviceRow = (
        <Item
            testID="settings.homes.device"
            title={t('addFlows.thisDeviceTitle')}
            subtitle={t('addFlows.thisDeviceSubtitle')}
            icon={(
                <HappierCollectionListMark>
                    <Icon name={Platform.OS === 'ios' || Platform.OS === 'android' ? 'device-mobile' : 'laptop'} size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            {...rowProps(selectedKey === 'device')}
            onPress={() => openHref(router, HOMES_DEVICE_ROUTE, rail && onDetailRoute, 'HomesCollectionList.device')}
        />
    );

    const homeRows = collection.homes.map((row) => (
        <Item
            key={row.id}
            testID={`settings.homes.row.${row.id}`}
            title={row.title}
            subtitle={describeHomeRow(row)}
            subtitleLeading={(
                <StatusDot
                    testID={`settings.homes.row.${row.id}.status`}
                    color={row.statusKey === 'connected'
                        ? theme.colors.status.connected
                        : row.statusKey === 'action_required'
                            ? theme.colors.status.actionRequired
                            : row.statusKey === 'error'
                                ? theme.colors.status.error
                                : theme.colors.status.disconnected}
                />
            )}
            icon={(
                <HappierCollectionListMark>
                    <HomeMark serverUrl={row.serverUrl} size="list" />
                </HappierCollectionListMark>
            )}
            {...rowProps(selectedKey === `home:${row.id}` || selectedKey === `home:${row.profile.id}`)}
            onPress={() => openHref(router, homeCollectionHref(row.id), rail && onDetailRoute, 'HomesCollectionList.home')}
        />
    ));

    const groupRows = collection.groups.map((row) => (
        <Item
            key={row.id}
            testID={`settings.homes.group.${row.id}`}
            title={row.title}
            subtitle={[
                t('server.serverCount', { count: row.count }),
                row.current ? t('addFlows.homesInUse') : null,
            ].filter(Boolean).join(' · ')}
            icon={(
                <HappierCollectionListMark>
                    <HomeMark glyph="stack" size="list" />
                </HappierCollectionListMark>
            )}
            {...rowProps(selectedKey === `group:${row.id}`)}
            onPress={() => openHref(router, homeGroupCollectionHref(row.id), rail && onDetailRoute, 'HomesCollectionList.group')}
        />
    ));

    if (!rail) {
        return (
            <>
                <ItemGroup>{deviceRow}</ItemGroup>
                <ItemGroup>
                    {homeRows}
                    <Item
                        testID="settings.homes.add"
                        title={t('addFlows.addHome')}
                        icon={<Icon name="plus" size={20} color={theme.colors.text.secondary} />}
                        onPress={() => openHref(router, HOMES_ADD_ROUTE, false, 'HomesCollectionList.add')}
                    />
                </ItemGroup>
                {groupRows.length > 0 ? <ItemGroup title={t('addFlows.groupsTitle')}>{groupRows}</ItemGroup> : null}
            </>
        );
    }

    return (
        <CollectionList
            testID="settings.homes.rail"
            title={t('settings.servers')}
            count={collection.homes.length}
            headerAction={<AddHomesMenu replace={onDetailRoute} />}
        >
            {selectedKey === 'homeDraft' ? <HomeDraftRow /> : null}
            {deviceRow}
            {homeRows}
            {selectedKey === 'groupDraft' || groupRows.length > 0 ? (
                <CollectionListGroupLabel title={t('addFlows.groupsTitle')} count={collection.groups.length} />
            ) : null}
            {selectedKey === 'groupDraft' ? <GroupDraftRow /> : null}
            {groupRows}
        </CollectionList>
    );
});

/** The Home being added, at the top of the rail while its form is open: titled by the address as it is typed. */
const HomeDraftRow = React.memo(function HomeDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.homes.rail.draft"
            titles={homeAddDraftTitle}
            placeholder={t('addFlows.newHomeDraft')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="plus" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

const GroupDraftRow = React.memo(function GroupDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.homes.rail.groupDraft"
            titles={homeGroupDraftTitle}
            placeholder={t('addFlows.newGroup')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="stack" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

/** The rail beside a Home's page. */
export const HomesCollectionRail = React.memo(function HomesCollectionRail() {
    return <HomesCollectionList variant="rail" />;
});
