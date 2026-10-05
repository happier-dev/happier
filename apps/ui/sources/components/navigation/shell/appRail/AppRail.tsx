import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useActivateAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { describeUpdatesEntry, UpdatesPopoverButton } from '@/components/updates/UpdatesPopoverButton';
import { useSharedInboxSummary } from '@/hooks/inbox/useInboxSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SidebarFooterPopoverButton, type SidebarFooterPopoverContentProps } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarUsagePopoverContent, USAGE_POPOVER_WIDTH_PX } from '../sidebarFooter/SidebarUsagePopoverContent';
import { AppRailAccount } from './AppRailAccount';
import { AppRailMachines } from './AppRailMachines';
import {
    APP_RAIL_ICON_GLYPH_SIZE_PX,
    APP_RAIL_ITEM_SIZE_PX,
    APP_RAIL_ITEM_SLOT_PX,
    APP_RAIL_WIDTH_PX,
} from './appRailMetrics';
import { AppRailBadge, resolveAppRailBadgeTone } from './AppRailBadge';
import { useConnectedAccountsNeedingSignInCount } from './useConnectedAccountsNeedingSignInCount';
import { AppRailPeek } from './AppRailPeek';
import {
    buildAppRailEntries,
    resolveAppRailEntryColumn,
    splitAppRailOverflow,
    type AppRailEntry,
} from './appRailModel';
import { useAppShellLocation } from './useAppShellLocation';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

const renderUsage = (content: SidebarFooterPopoverContentProps) => <SidebarUsagePopoverContent {...content} />;

/**
 * The one rail glyph: every icon on the rail is this size in the same box, filled and primary when
 * its destination is open. Popover buttons on the rail take the same size (`APP_RAIL_ICON_GLYPH_SIZE_PX`).
 */
const AppRailIcon = React.memo(function AppRailIcon(props: Readonly<{ name: IconName; active?: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <Icon
            name={props.name}
            size={APP_RAIL_ICON_GLYPH_SIZE_PX}
            weight={props.active ? 'fill' : 'regular'}
            color={props.active ? theme.colors.text.primary : theme.colors.text.secondary}
        />
    );
});

/**
 * The app's rail (lab `xrail-R1`): every destination as an icon, the open one filled. The app's own
 * destinations come first, then Plugins and the plugin destinations that asked for the navigation;
 * those that do not fit go into "More". At the bottom: Usage and Machines (their popovers, Usage's
 * only where connected-account limits are reported), Updates
 * while one exists, Settings and the person, whose Home/account popover opens from the avatar.
 */
export const AppRail = React.memo(function AppRail() {
    const styles = stylesheet;
    const { catalog, location } = useAppShellLocation();
    const entries = React.useMemo(() => buildAppRailEntries(catalog), [catalog]);
    const activeId = location.railEntryId;
    const open = useActivateAppDestination();

    // The plugin group takes whatever height the app's destinations and the bottom leave.
    const [pluginSlots, setPluginSlots] = React.useState<number | null>(null);
    const onPluginAreaLayout = React.useCallback((event: LayoutChangeEvent) => {
        const slots = Math.floor(event.nativeEvent.layout.height / APP_RAIL_ITEM_SLOT_PX);
        setPluginSlots((current) => (current === slots ? current : slots));
    }, []);
    const plugins = splitAppRailOverflow(entries.plugins, pluginSlots);

    return (
        <View testID="app-rail" style={styles.rail}>
            <View style={styles.group}>
                {entries.app.map((entry) => (
                    <AppRailItem key={entry.id} entry={entry} active={activeId === entry.id} onOpen={open} />
                ))}
            </View>
            <View style={styles.separator} />
            <View testID="app-rail-plugins" style={styles.pluginArea} onLayout={onPluginAreaLayout}>
                {plugins.shown.map((entry) => (
                    <AppRailItem key={entry.id} entry={entry} active={activeId === entry.id} onOpen={open} />
                ))}
                {plugins.overflow.length > 0 ? (
                    <AppRailMore
                        entries={plugins.overflow}
                        active={plugins.overflow.some((entry) => entry.id === activeId)}
                        onOpen={open}
                    />
                ) : null}
            </View>
            <AppRailBottom account={entries.account} activeId={activeId} onOpen={open} />
        </View>
    );
});

const AppRailItem = React.memo(function AppRailItem(props: Readonly<{
    entry: AppRailEntry;
    active: boolean;
    onOpen: (entry: AppRailEntry) => void;
}>) {
    const styles = stylesheet;
    const { entry } = props;
    const shortcut = useKeyboardShortcutLabel(entry.kind === 'builtin' ? entry.shortcut : undefined);
    const tooltip = shortcut ? `${entry.title}  ${shortcut}` : entry.title;
    const unavailable = entry.availability !== 'available';
    const column = resolveAppRailEntryColumn(entry);
    // A plugin destination's static badge ("Beta") has no room for text on the rail: it marks the icon.
    const pluginBadge = entry.kind === 'plugin' ? entry.badge ?? null : null;
    const button = (peeks: boolean) => (
        <IconButton
            testID={`app-rail:${entry.id}`}
            variant="plain"
            size={APP_RAIL_ITEM_SIZE_PX}
            accessibilityLabel={entry.title}
            // Where resting on the icon peeks its column, the column says what it is.
            tooltip={peeks ? undefined : tooltip}
            tooltipPlacement="right"
            selected={props.active}
            disabled={unavailable}
            icon={<AppRailIcon name={entry.icon} active={props.active} />}
            onPress={() => props.onOpen(entry)}
        />
    );
    return (
        <WorkspaceDestinationRow style={styles.itemSlot}
            href={!unavailable && entry.activation === 'navigate' ? entry.routePath : null}>
            {column
                ? <AppRailPeek testID={`app-rail-peek:${entry.id}`} destinationId={entry.id}>{button}</AppRailPeek>
                : button(false)}
            {entry.kind === 'builtin' && entry.signal === 'inboxCount' ? <AppRailInboxBadge testID={`app-rail:${entry.id}-badge`} /> : null}
            {pluginBadge ? (
                <AppRailBadge
                    testID={`app-rail:${entry.id}-badge`}
                    signal={{ kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'plugin', tone: pluginBadge.tone }) }}
                />
            ) : null}
        </WorkspaceDestinationRow>
    );
});

/** The Inbox count: read only by this leaf, so a new item re-renders the badge and nothing else. */
const AppRailInboxBadge = React.memo(function AppRailInboxBadge(props: Readonly<{ testID: string }>) {
    const summary = useSharedInboxSummary();
    if (summary.count <= 0) return null;
    return (
        <AppRailBadge
            testID={props.testID}
            signal={{ kind: 'count', value: summary.count, tone: resolveAppRailBadgeTone({ source: 'inbox' }) }}
        />
    );
});

const AppRailMore = React.memo(function AppRailMore(props: Readonly<{
    entries: readonly AppRailEntry[];
    active: boolean;
    onOpen: (entry: AppRailEntry) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const wrapItem = React.useCallback((item: Readonly<{ id: string }>, children: React.ReactNode) => {
        const entry = props.entries.find(candidate => candidate.id === item.id);
        return <WorkspaceDestinationRow href={entry?.availability === 'available' && entry.activation === 'navigate'
            ? entry.routePath : null}>{children}</WorkspaceDestinationRow>;
    }, [props.entries]);
    const items = props.entries.map((entry): DropdownMenuItem => ({
        id: entry.id,
        testID: `app-rail-more:${entry.id}`,
        title: entry.title,
        icon: <Icon name={entry.icon} size={MENU_ROW_METRICS.iconGlyphSizePx} color={theme.colors.text.secondary} />,
        disabled: entry.availability !== 'available',
    }));
    return (
        <View style={styles.itemSlot}>
            <DropdownMenu
                testID="app-rail-more"
                open={open}
                onOpenChange={setOpen}
                items={items}
                wrapItem={wrapItem}
                onSelect={(id) => {
                    setOpen(false);
                    const entry = props.entries.find((candidate) => candidate.id === id);
                    if (entry) props.onOpen(entry);
                }}
                placement="right"
                variant="slim"
                matchTriggerWidth={false}
                popoverPortalWebTarget="body"
                trigger={({ toggle }) => (
                    <IconButton
                        testID="app-rail-more.trigger"
                        variant="plain"
                        size={APP_RAIL_ITEM_SIZE_PX}
                        accessibilityLabel={t('common.moreActions')}
                        tooltip={t('common.moreActions')}
                        tooltipPlacement="right"
                        tooltipHidden={open}
                        selected={props.active || open}
                        icon={<AppRailIcon name="dots-three" />}
                        onPress={toggle}
                    />
                )}
            />
        </View>
    );
});

const AppRailBottom = React.memo(function AppRailBottom(props: Readonly<{
    account: readonly AppRailEntry[];
    activeId: string | null;
    onOpen: (entry: AppRailEntry) => void;
}>) {
    const styles = stylesheet;
    const router = useRouter();
    const updatesSummary = useSharedUpdatesSummary();
    const updatesCopy = describeUpdatesEntry(updatesSummary);
    const updatesVisible = updatesCopy !== null;
    // The Usage popover previews connected-account limits where this Home reports them; the icon
    // itself is always there and otherwise opens the Usage page.
    const quotaMetersAvailable = useFeatureEnabled('connectedServices.quotas');
    // A red count only for accounts that need a new sign-in; low limits never badge (lab G2).
    const signInCount = useConnectedAccountsNeedingSignInCount();
    const openUsage = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.usage as never));
        if (result !== true) fireAndForget(result, { tag: 'AppRail.usage' });
    }, [router]);
    return (
        <View testID="app-rail-bottom" style={styles.group}>
            <WorkspaceDestinationRow href={SETTINGS_ROUTES.usage} style={styles.itemSlot}>
                {quotaMetersAvailable ? (
                    <SidebarFooterPopoverButton
                        testID="app-rail-usage"
                        iconName="speedometer"
                        label={t('settings.usage')}
                        placement="right"
                        buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
                        iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
                        popoverWidthPx={USAGE_POPOVER_WIDTH_PX}
                        hoverPreview
                        renderContent={renderUsage}
                    />
                ) : (
                    // Without connected-account limits there is nothing to preview: the icon opens Usage.
                    <IconButton
                        testID="app-rail-usage"
                        variant="plain"
                        size={APP_RAIL_ITEM_SIZE_PX}
                        accessibilityLabel={t('settings.usage')}
                        tooltip={t('settings.usage')}
                        tooltipPlacement="right"
                        icon={<AppRailIcon name="speedometer" />}
                        onPress={openUsage}
                    />
                )}
                {signInCount > 0 ? (
                    <AppRailBadge
                        testID="app-rail-usage-badge"
                        signal={{ kind: 'count', value: signInCount, tone: resolveAppRailBadgeTone({ source: 'signIn' }) }}
                    />
                ) : null}
            </WorkspaceDestinationRow>
            <View style={styles.itemSlot}>
                <AppRailMachines />
            </View>
            {updatesVisible ? (
                <View style={styles.itemSlot}>
                    <UpdatesPopoverButton
                        summary={updatesSummary}
                        variant="footer"
                        buttonSize={APP_RAIL_ITEM_SIZE_PX}
                        markSize={APP_RAIL_ICON_GLYPH_SIZE_PX}
                        hostDrawsCount
                        testID="app-rail-updates"
                    />
                    {updatesCopy?.count ? (
                        <AppRailBadge
                            testID="app-rail-updates-badge"
                            signal={{
                                kind: 'count',
                                value: updatesCopy.count,
                                tone: resolveAppRailBadgeTone({ source: 'updates', failed: updatesCopy.warning === true }),
                            }}
                        />
                    ) : null}
                </View>
            ) : null}
            {props.account.map((entry) => (
                <AppRailItem key={entry.id} entry={entry} active={props.activeId === entry.id} onOpen={props.onOpen} />
            ))}
            <View style={styles.itemSlot}>
                <AppRailAccount />
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        width: APP_RAIL_WIDTH_PX,
        flexShrink: 0,
        minHeight: 0,
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 12,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.background.canvas, 'chrome', true),
    },
    group: {
        alignItems: 'center',
    },
    pluginArea: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        overflow: 'hidden',
    },
    itemSlot: {
        width: APP_RAIL_WIDTH_PX,
        height: APP_RAIL_ITEM_SLOT_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    separator: {
        width: 24,
        height: StyleSheet.hairlineWidth,
        marginVertical: 8,
        backgroundColor: theme.colors.border.default,
    },
}));
