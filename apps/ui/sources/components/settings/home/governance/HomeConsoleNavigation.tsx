import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierFieldBoxTrigger,
    HappierPressable,
    resolveHappierFieldBoxLabel,
    useHappierCollectionLayout,
} from '@happier-dev/plugin-ui/presentation';
import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';

import { SettingsFloatingControlsHost } from '@/components/settings/shell/SettingsModalFloatingControls';
import { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { appShellColumnSurface } from '@/components/navigation/shell/appRail/appShellColumnSurface';
import { AppShellMaterialPlane } from '@/components/navigation/shell/AppShellMaterialFrame';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { HomeMark } from '@/components/homes/HomeMark';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
    MENU_ROW_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHomeAdministration } from '@/hooks/home/useHomeAdministration';
import { resolveHomeViewerRole } from '@/hooks/home/resolveHomeViewerRole';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { homeAdministrationHomesPath } from './homeAdministrationRoutes';
import {
    HOME_CONSOLE_DESTINATION_GROUPS,
    resolveActiveHomeConsoleDestination,
    resolveHomeConsoleDestinations,
} from './homeConsoleDestinations';

/** Which rail stands beside the console's pages: its own, or People's while a person is open. */
export type HomeConsoleRailKind = 'console' | 'people';

type HomeConsoleShellValue = Readonly<{ serverId: string; rail: HomeConsoleRailKind }>;

const HomeConsoleShellContext = React.createContext<HomeConsoleShellValue | null>(null);

/**
 * Marks the content as the Home console's pages, so each page knows how the console's navigation
 * reaches it. Provided by the console's collection layout; a page rendered anywhere else has none.
 */
export function HomeConsoleShell(props: Readonly<{
    serverId: string;
    rail: HomeConsoleRailKind;
    children: React.ReactNode;
}>) {
    const value = React.useMemo(() => ({ serverId: props.serverId, rail: props.rail }), [props.rail, props.serverId]);
    return <HomeConsoleShellContext.Provider value={value}>{props.children}</HomeConsoleShellContext.Provider>;
}

/** The narrowest window that holds the settings navigation, the console's sidebar and a page (R16). */
export const HOME_CONSOLE_SIDEBAR_MIN_WINDOW_PX = 1280;
/** The console sidebar: the Home's name and role, and page titles at normal text scale. */
export const HOME_CONSOLE_SIDEBAR_WIDTH_PX = 232;

/**
 * How the console's pages are reached right now (plan §3.10, R16):
 * - `sidebar`: a second sidebar beside the settings navigation, from a 1280px window;
 * - `menu`: narrower, the pages fold into a header menu above the page;
 * - `index`: a phone, where Overview lists the pages and each one is pushed;
 * - `none`: outside the console.
 */
export type HomeConsoleNavigationMode = 'sidebar' | 'menu' | 'index' | 'none';

export function useHomeConsoleNavigation(): HomeConsoleNavigationMode {
    const shell = React.useContext(HomeConsoleShellContext);
    const phone = useDeviceType() === 'phone';
    const { width } = useWindowDimensions();
    if (!shell) return 'none';
    if (phone) return 'index';
    return width >= HOME_CONSOLE_SIDEBAR_MIN_WINDOW_PX ? 'sidebar' : 'menu';
}

/** Whether People's rail stands beside the page: a person is open where list and detail both fit. */
export function useHomePeopleRailBeside(): boolean {
    const shell = React.useContext(HomeConsoleShellContext);
    const layout = useHappierCollectionLayout();
    return shell?.rail === 'people' && layout?.mode === 'split';
}

/**
 * A console page whose way back is already on screen carries no back control of its own: Overview
 * while the console's navigation (with its way back to the Homes) is shown, a person while People's
 * rail is beside them. Elsewhere the page keeps the settings back control.
 */
export function HomeConsoleBackScope(props: Readonly<{
    /** Where this page's back would lead. */
    parentPathname: string;
    /** What already shows that parent: the console's navigation, or People's rail. */
    shownBy: 'consoleNavigation' | 'peopleRail';
    children: React.ReactNode;
}>) {
    const navigation = useHomeConsoleNavigation();
    const peopleRailBeside = useHomePeopleRailBeside();
    const shown = props.shownBy === 'peopleRail' ? peopleRailBeside : navigation === 'sidebar' || navigation === 'menu';
    return (
        <SettingsFloatingControlsHost enabled={shown} collectionRootPathname={props.parentPathname}>
            {props.children}
        </SettingsFloatingControlsHost>
    );
}

type HomeConsoleIdentity = Readonly<{
    homeName: string;
    /** The Home's address, which its mark is drawn from. */
    serverUrl: string | null;
    role: string | null;
    projection: HomeGovernanceProjectionV1 | null;
}>;

/** Which Home this is and as whom, as the rail header and the header menu name it. */
function useHomeConsoleIdentity(serverId: string): HomeConsoleIdentity {
    const binding = useHomeAdministration(serverId);
    const serverUrl = React.useMemo(() => {
        const profile = getServerProfileById(serverId);
        return profile ? profile.canonicalServerUrl ?? profile.serverUrl : null;
    }, [serverId]);
    const homeName = 'homeName' in binding ? binding.homeName : '';
    const state = binding.kind === 'bound' ? binding.state : null;
    const projection = state?.kind === 'ready' ? state.projection : null;
    const setupRequired = state?.kind === 'setup_required' || projection?.setupState === 'setup_required';
    const viewerRole = resolveHomeViewerRole(binding);
    const role = setupRequired
        ? t('homeGovernance.console.noOwnerYet')
        : viewerRole === 'owner'
            ? t('homeGovernance.console.viewerOwner')
            : viewerRole === 'admin'
                ? t('homeGovernance.console.viewerAdmin')
                : null;
    return { homeName, serverUrl, role, projection: setupRequired ? null : projection };
}

function openConsolePath(router: ReturnType<typeof useRouter>, href: string, tag: string) {
    // Beside the console's navigation a page replaces the one shown; it never stacks history.
    const result = runGuardedNavigation(() => router.replace(href as never));
    if (result !== true) fireAndForget(result, { tag });
}

function openHomes(router: ReturnType<typeof useRouter>, tag: string) {
    const result = runGuardedNavigation(() => router.dismissTo(homeAdministrationHomesPath() as never));
    if (result !== true) fireAndForget(result, { tag });
}

/**
 * The console's navigation as a second sidebar beside the settings navigation (user decision
 * 2026-09-27, superseding the R1h drill-in): the Home's mark, name and the viewer's role, then its
 * pages as the settings navigation's own flat rows (`CollectionNavigationRow`) on the same plane, groups set
 * apart by air rather than sheets. The open page, from the route, is selected.
 */
export const HomeConsoleSidebar = React.memo(function HomeConsoleSidebar(props: Readonly<{ serverId: string }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeId = resolveActiveHomeConsoleDestination(usePathname(), props.serverId);
    const identity = useHomeConsoleIdentity(props.serverId);
    const groups = resolveHomeConsoleDestinations(identity.projection);
    return (
        <AppShellMaterialPlane testID="home-console-sidebar" group="sidebar" color={theme.colors.surface.inset} translucentColor={theme.colors.surface.selected} style={[styles.sidebar, appShellColumnSurface.plane]}>
            <View style={styles.header}>
                <HomeMark serverUrl={identity.serverUrl} />
                <View style={styles.identity}>
                    <Text style={styles.homeName} numberOfLines={1}>{identity.homeName}</Text>
                    {identity.role ? (
                        <Text testID="home-console-rail-role" style={styles.role} numberOfLines={1}>{identity.role}</Text>
                    ) : null}
                </View>
            </View>
            <ItemList presentation="grouped" style={[styles.scroller, { backgroundColor: theme.colors.surface.inset }]} accessibilityLabel={t('homeGovernance.console.navigation')}>
                {groups.map((group, index) => (
                    <React.Fragment key={group[0]!.id}>
                        {index > 0 ? <View style={styles.groupGap} /> : null}
                        {group.map((destination) => (
                            <CollectionNavigationRow
                                key={destination.id}
                                testID={`home-console-rail:${destination.id}`}
                                title={t(destination.titleKey)}
                                icon={<Icon name={destination.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                                selected={activeId === destination.id}
                                onPress={() => openConsolePath(router, destination.path(props.serverId), 'HomeConsoleSidebar.open')}
                            />
                        ))}
                    </React.Fragment>
                ))}
            </ItemList>
        </AppShellMaterialPlane>
    );
});

const ALL_HOMES_ITEM_ID = 'all-homes';

/**
 * The console rail folded into one control above the page (lab `hcOverview-N`/`-M`): the Home and the
 * open page in a field, and the same pages — plus a way back to all Homes — in its menu. Rendered only
 * where the rail is not beside the page.
 */
export const HomeConsoleMenu = React.memo(function HomeConsoleMenu(props: Readonly<{ serverId: string }>) {
    const navigation = useHomeConsoleNavigation();
    if (navigation !== 'menu') return null;
    return <HomeConsoleMenuControl serverId={props.serverId} />;
});

const HomeConsoleMenuControl = React.memo(function HomeConsoleMenuControl(props: Readonly<{ serverId: string }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeId = resolveActiveHomeConsoleDestination(usePathname(), props.serverId);
    const maxWidth = useLayoutMaxWidth();
    const [open, setOpen] = React.useState(false);
    const identity = useHomeConsoleIdentity(props.serverId);
    const groups = resolveHomeConsoleDestinations(identity.projection);
    const active = HOME_CONSOLE_DESTINATION_GROUPS.flat().find((destination) => destination.id === activeId)
        ?? HOME_CONSOLE_DESTINATION_GROUPS[0]![0]!;
    const activeTitle = t(active.titleKey);
    const fieldColors = resolveFieldBoxColors(theme);
    const fieldLabel = resolveHappierFieldBoxLabel({ value: activeTitle, placeholder: activeTitle, colors: fieldColors });
    const glyph = (name: React.ComponentProps<typeof Icon>['name']) => (
        <Icon name={name} size={MENU_ROW_METRICS.iconGlyphSizePx} color={theme.colors.text.secondary} />
    );
    const items: DropdownMenuItem[] = [
        ...groups.flatMap((group, index) => group.map((destination) => ({
            id: destination.id,
            testID: `home-console-menu:${destination.id}`,
            title: t(destination.titleKey),
            icon: glyph(destination.icon),
            category: `group-${index}`,
        }))),
        {
            id: ALL_HOMES_ITEM_ID,
            testID: `home-console-menu:${ALL_HOMES_ITEM_ID}`,
            title: t('homeGovernance.console.allHomes'),
            icon: glyph('caret-left'),
            category: 'homes',
        },
    ];
    return (
        <View style={[styles.menuColumn, { maxWidth }]}>
            <DropdownMenu
                testID="home-console-menu"
                open={open}
                onOpenChange={setOpen}
                items={items}
                selectedId={activeId}
                onSelect={(id) => {
                    setOpen(false);
                    if (id === ALL_HOMES_ITEM_ID) {
                        openHomes(router, 'HomeConsoleMenu.homes');
                        return;
                    }
                    const destination = HOME_CONSOLE_DESTINATION_GROUPS.flat().find((candidate) => candidate.id === id);
                    if (destination) openConsolePath(router, destination.path(props.serverId), 'HomeConsoleMenu.open');
                }}
                placement="bottom"
                popoverAnchorAlign="start"
                variant="slim"
                matchTriggerWidth={false}
                showCategoryTitles={false}
                popoverPortalWebTarget="body"
                trigger={({ toggle }) => (
                    <HappierPressable
                        testID="home-console-menu.trigger"
                        onPress={toggle}
                        accessibilityRole="button"
                        accessibilityLabel={`${identity.homeName}: ${activeTitle}`}
                        expanded={open}
                        hasPopup="menu"
                        style={styles.menuTrigger}
                    >
                        {/* The field box of a toolbar select; the page name keeps its width and the Home's
                            name gives way first. */}
                        <HappierFieldBoxTrigger
                            colors={fieldColors}
                            trailing={<Icon name={open ? 'caret-up' : 'caret-down'} size={MENU_ROW_METRICS.iconGlyphSizePx} color={theme.colors.text.secondary} />}
                        >
                            <Text style={[fieldLabel.style, styles.menuHome]} numberOfLines={1}>{identity.homeName}</Text>
                            <Text style={[fieldLabel.style, styles.menuSlash]}>/</Text>
                            {glyph(active.icon)}
                            <Text style={[fieldLabel.style, styles.menuPage]} numberOfLines={1}>{activeTitle}</Text>
                        </HappierFieldBoxTrigger>
                    </HappierPressable>
                )}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    // Beside the settings navigation on the same plane: a hairline tells the two columns apart.
    sidebar: {
        width: HOME_CONSOLE_SIDEBAR_WIDTH_PX,
        flexShrink: 0,
        minHeight: 0,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
        paddingTop: theme.margins.md,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 4,
        paddingBottom: theme.margins.md,
        paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset - 4,
    },
    groupGap: {
        height: theme.margins.md,
    },
    identity: {
        flex: 1,
        minWidth: 0,
    },
    homeName: {
        ...Typography.default('semiBold'),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
    },
    role: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    scroller: {
        flex: 1,
    },
    menuColumn: {
        width: '100%',
        alignSelf: 'center',
        alignItems: 'flex-start',
        // Navigation chrome above the page header, which keeps its own top padding below it.
        paddingTop: PAGE_LIST_METRICS.pageHeaderUnderChromePaddingTopPx,
        paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    },
    menuTrigger: {
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
        justifyContent: 'center',
        maxWidth: '100%',
    },
    // The field label grows to fill the box; here each part keeps its own width instead.
    menuHome: {
        ...Typography.default('semiBold'),
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: 'auto',
        minWidth: 0,
    },
    menuSlash: {
        color: theme.colors.text.tertiary,
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
    },
    menuPage: {
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
    },
}));
