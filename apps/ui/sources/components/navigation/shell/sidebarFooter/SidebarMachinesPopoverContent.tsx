import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useAuth } from '@/auth/context/AuthContext';
import { useMachineCollection } from '@/components/settings/machines/collection/useMachineCollection';
import { MachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
import { useMachineAddPaths, useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import {
    MachineWorkingCountsProvider,
    useMachineWorkingCount,
    useMachineWorkingTotal,
} from '@/components/machines/work/machineWorkingCounts';
import {
    MACHINES_ADD_ROUTE,
    buildMachineAddHref,
    machineCollectionHref,
    machineCollectionRowKey,
    machinesIndexHref,
    type MachineCollectionRow,
    type MachineCollectionSection,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachineAddOptions } from '@/components/settings/machines/collection/useMachineAddOptions';
import { useMachinesSettingsViewModel } from '@/components/settings/machines/machinesSettingsViewModel';
import { MachinePoolsSection } from '@/components/settings/machines/sections/MachinePoolsSection';
import { MachineSummaryCaption } from '@/components/machines/summary/MachineSummaryCaption';
import { MachineSummaryCustomizePanel } from '@/components/machines/summary/MachineSummaryCustomizePanel';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import { MachineSummaryFreshnessLine } from '@/components/machines/summary/MachineSummaryFreshnessLine';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceRefreshing, useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { MachineResourceKey } from '@/sync/domains/machines/resources/machineRpc';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { describeFleetTitle, selectAttentionSubjects } from '@/components/machines/summary/machineResourceSentences';

import { machineHeaderOriginKey, setMachineHeaderOrigin } from '@/components/machines/page/machineHeaderOrigin';
import { measureInWindow } from '@/components/ui/popover/measure';
import { unionWindowFlightRects } from '@/components/ui/motion/rectFlight';

import { collectMachineAttention } from '@/components/machines/attention/collectMachineAttention';

import { MachinesNeedsYouGroup, MachinesSinceYouLastLooked } from './MachinesPopoverAttention';
import { RAIL_POPOVER_ROSTER_LIST_STYLE, RailPopoverRoster } from './RailPopoverRoster';
import type { SidebarFooterPopoverContentProps } from './SidebarFooterPopoverButton';

/**
 * The rail's Machines popover (lab `rm` P / PS): every machine the Homes the app shows hold, in the
 * one machine collection model the list column uses (the same groups and titles, then pools), each
 * row with what it is doing now. Rows and "All machines" open the one Machines page through the rail
 * door; the rows beneath add a machine or a pool. Mounted only while the popover is open; the
 * working counts are projected per machine inside it, so one machine's session update re-renders
 * only that machine's row.
 */
export function SidebarMachinesPopoverContent(props: SidebarFooterPopoverContentProps & Readonly<{
    /** When this device last opened the popover (before this opening recorded itself): "Since you last looked". */
    guardSeenAt?: number;
}>) {
    return (
        <MachineWorkingCountsProvider>
            <MachinesPopoverBody close={props.close} maxHeight={props.maxHeight} guardSeenAt={props.guardSeenAt ?? 0} />
        </MachineWorkingCountsProvider>
    );
}

const MachinesPopoverBody = React.memo(function MachinesPopoverBody(props: SidebarFooterPopoverContentProps & Readonly<{ guardSeenAt: number }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const model = useMachinesSettingsViewModel();
    const addOptions = useMachineAddOptions(model.visibleMachineGroups);
    const addPaths = useMachineAddPaths();
    const thisComputerMachineId = useThisComputerMachineId();
    const nowMs = Date.now();
    const collection = useMachineCollection({
        groups: model.visibleMachineGroups,
        groupedByHome: model.showMachinesGroupedByServer,
        managedByServerId: model.managedByServerId,
        managedFirstAnswerPending: model.managedFirstAnswerPending,
    });
    // What each machine publishes (plan 20): the sentence title, Needs you first, then everything else.
    const attention = React.useMemo(() => collectMachineAttention(model.visibleMachineGroups), [collection, model.reachabilityRevision, model.visibleMachineGroups]);
    const needsYouKeys = React.useMemo(() => new Set(selectAttentionSubjects(attention.entries).map(entry => entry.key)), [attention.entries]);
    // The glance is about machines: archived recovery rows stay in the collection's own list; a machine
    // listed under Needs you is not listed again below it.
    const sections = React.useMemo(() => collection.sections.filter(section => !section.archived).map(section => needsYouKeys.size === 0 ? section : {
        ...section,
        rows: section.rows.filter(row => row.kind !== 'machine' || !needsYouKeys.has(JSON.stringify([row.serverId, row.machineId]))),
    }), [collection.sections, needsYouKeys]);
    const machineCount = sections.reduce((count, section) => count + section.rows.length, 0) + needsYouKeys.size;
    // Counted by the one presence owner (the rail tooltip and Home's Machines section count the same way).
    const counts = React.useMemo(() => collection.sections.flatMap(section => section.rows).reduce((result, row) => {
        if (row.kind !== 'machine') return result;
        if (row.online) result.online += 1;
        else if (row.status === 'offline') result.offline += 1;
        else result.unknown += 1;
        return result;
    }, { online: 0, offline: 0, unknown: 0 }), [collection.sections]);
    // Values are live only while the popover is open: one batched demand for the online machines it lists.
    const summary = useMachineSummarySettingValue();
    const demandKeys = React.useMemo((): MachineResourceKey[] => collection.sections.filter(section => !section.archived).flatMap(section => section.rows)
        .filter(row => row.online && row.kind === 'machine')
        .map(row => ({ serverId: row.serverId, machineId: row.kind === 'machine' ? row.machineId : '' })), [collection.sections]);
    useMachineResourceLiveDemand(demandKeys, { detail: 'summary', enabled: summary.metrics.length > 0 || needsYouKeys.size > 0 });
    const refreshing = useMachineResourceRefreshing(demandKeys);
    const [customizing, setCustomizing] = React.useState(false);

    const latest = React.useRef(props.close);
    latest.current = props.close;
    const open = React.useCallback((href: string, tag: string) => {
        latest.current();
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const openRow = React.useCallback((row: MachineCollectionRow, identity?: readonly unknown[]) => {
        // The row's mark + name rectangle travels to the machine page's header's mark + name (MPG-32): measured in
        // window coordinates on press, handed over once.
        const nodes = (identity ?? []).filter(Boolean);
        const machineId = row.kind === 'machine' ? row.machineId : row.enrolledMachineId;
        if (nodes.length === 0 || !machineId) {
            open(machineCollectionHref(row, 'rail'), 'SidebarMachines.openMachine');
            return;
        }
        fireAndForget(Promise.all(nodes.map(node => measureInWindow(node))).then(rects => {
            setMachineHeaderOrigin(machineHeaderOriginKey({ serverId: row.serverId, machineId }), unionWindowFlightRects(rects));
            open(machineCollectionHref(row, 'rail'), 'SidebarMachines.openMachine');
        }), { tag: 'SidebarMachines.openMachine' });
    }, [open]);
    const signIn = React.useCallback((serverId: string) => {
        latest.current();
        fireAndForget((async () => {
            // The signed-out Home becomes the active one, whose own sign-in the app then shows.
            const result = await setActiveServerAndSwitch({
                serverId,
                scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                refreshAuth: auth.refreshFromActiveServer,
            });
            if (result !== 'blocked') router.replace('/' as never);
        })(), { tag: 'SidebarMachines.signIn' });
    }, [auth.refreshFromActiveServer, router]);

    const signedOutGroups = model.visibleMachineGroups.filter(group => group.status === 'signedOut');
    const loading = (model.isLoadingMachines && machineCount === 0) || collection.firstAnswerPending;
    const empty = !loading && machineCount === 0 && signedOutGroups.length === 0;
    const addPool = addOptions.find(option => option.id === 'pool') ?? null;
    const iconColor = theme.colors.text.secondary;

    if (empty) {
        const thisComputer = addPaths.find(path => path.id === 'thisComputer' && !path.connectedMachineId) ?? null;
        return (
            <View testID="sidebar-machines-popover-content" style={styles.invitation}>
                <EmptyState
                    testID="sidebar-machines-empty"
                    layout="inline"
                    iconName="desktop"
                    title={t('sidebarFooter.machinesEmptyTitle')}
                    subtitle={t('sidebarFooter.machinesEmptyBody')}
                    primaryAction={thisComputer ? {
                        testID: 'sidebar-machines-add-this-computer',
                        label: t('sidebarFooter.machinesAddThisComputer'),
                        onPress: () => open(buildMachineAddHref({ path: 'thisComputer' }), 'SidebarMachines.addThisComputer'),
                    } : {
                        testID: 'sidebar-machines-add-machine',
                        label: t('settings.addMachine'),
                        onPress: () => open(MACHINES_ADD_ROUTE, 'SidebarMachines.addMachine'),
                    }}
                    secondaryAction={thisComputer ? {
                        testID: 'sidebar-machines-add-another',
                        label: t('sidebarFooter.machinesAddAnotherMachine'),
                        onPress: () => open(MACHINES_ADD_ROUTE, 'SidebarMachines.addMachine'),
                    } : undefined}
                />
            </View>
        );
    }

    return (
        <RailPopoverRoster
            testID="sidebar-machines-popover-content"
            maxHeight={props.maxHeight}
            title={describeFleetTitle({ subjects: attention.entries, reportingCount: attention.reportingCount }) ?? t('settings.machines')}
            summary={(
                <View style={styles.counts}>
                {refreshing ? <ActivitySpinner testID="sidebar-machines-refreshing" size="small" /> : null}
                <PageHeaderMenu
                    testID="sidebar-machines-menu"
                    actions={[
                        { id: 'customize', testID: 'sidebar-machines-menu-customize', title: t('machineSummary.customize'),
                            onSelect: () => setCustomizing(true) } satisfies PageHeaderMenuAction,
                        { id: 'appearance', testID: 'sidebar-machines-menu-appearance', title: t('machineSummary.appearanceSettings'),
                            onSelect: () => open(SETTINGS_ROUTES.appearance, 'SidebarMachines.appearance') } satisfies PageHeaderMenuAction,
                    ]}
                />
                </View>
            )}
            subheader={(
                <>
                    {/* A summary that stopped answering says how old it is, with Retry, where the counts stand. */}
                    <MachineSummaryFreshnessLine machineKeys={demandKeys} fallback={(
                        <View style={styles.counts}>
                            <MachinePresenceCounts testID="sidebar-machines-presence" counts={counts} />
                            <WorkingTotal />
                        </View>
                    )} />
                    {/* With one machine there is nothing to summarise: its row is the summary. */}
                    {machineCount > 1 ? (
                        <HappierPressable
                            testID="sidebar-machines-all"
                            accessibilityRole="link"
                            accessibilityLabel={t('allMachines.rowTitle')}
                            onPress={() => open(machinesIndexHref('rail'), 'SidebarMachines.allMachines')}
                            style={styles.allMachines}
                        >
                            <Text style={styles.allMachinesText} numberOfLines={1}>{t('allMachines.rowTitle')}</Text>
                            <Icon name="caret-right" size={ICON_SIZE.xs} color={iconColor} />
                        </HappierPressable>
                    ) : null}
                </>
            )}
            actions={[
                {
                    id: 'add-machine',
                    testID: 'sidebar-machines-add-machine',
                    label: t('settings.addMachine'),
                    icon: <Icon name="plus" size={16} color={iconColor} />,
                    onPress: () => open(MACHINES_ADD_ROUTE, 'SidebarMachines.addMachine'),
                },
                addPool ? {
                    id: 'add-pool',
                    testID: 'sidebar-machines-add-pool',
                    label: addPool.title,
                    icon: <Icon name="plus" size={16} color={iconColor} />,
                    onPress: () => open(addPool.href, 'SidebarMachines.addPool'),
                } : null,
            ]}
        >
            {/* The panel opens between the header and the list, so the rows beneath are its live preview. */}
            {customizing ? <MachineSummaryCustomizePanel onDone={() => setCustomizing(false)} /> : null}
            {/* The list scrolls inside a fixed frame: the header and the add rows never move. */}
            <ScrollView
                testID="sidebar-machines-list"
                style={RAIL_POPOVER_ROSTER_LIST_STYLE}
                keyboardShouldPersistTaps="always"
            >
                {loading ? (
                    <Item testID="sidebar-machines-loading" title={t('common.loading')} density="compact" mode="info"
                        showChevron={false} pressableStyle={collectionListStyles.row} />
                ) : null}
                <MachinesSinceYouLastLooked entries={attention.entries} guardSeenAt={props.guardSeenAt} />
                <MachinesNeedsYouGroup entries={attention.entries} nowMs={nowMs} onOpen={open}
                    caption={<MachineSummaryCaption metrics={summary.metrics} style={summary.style} />} />
                {sections.filter(section => section.rows.length > 0).map((section, index) => (
                    <MachinesPopoverSection
                        key={section.key}
                        section={section}
                        // One caption names the instruments, on the first group's line (R7).
                        caption={index === 0 && needsYouKeys.size === 0 ? <MachineSummaryCaption metrics={summary.metrics} style={summary.style} /> : null}
                        thisComputerMachineId={thisComputerMachineId}
                        onOpenRow={openRow}
                    />
                ))}
                {/* A Home this device is signed out of has nothing to list: it says why, with the way back in. */}
                {signedOutGroups.filter(group => !sections.some(section => section.serverId === group.serverId && section.rows.length > 0)).map(group => (
                    <React.Fragment key={`signedOut:${group.serverId}`}>
                        {model.showMachinesGroupedByServer ? <CollectionListGroupLabel title={group.serverName} /> : null}
                        <SignedOutHomeLine serverId={group.serverId} home={group.serverName} onSignIn={signIn} />
                    </React.Fragment>
                ))}
                <MachinePoolsSection groups={model.visibleMachineGroups} variant="rail"
                    onOpen={href => open(href, 'SidebarMachines.openPool')} />
            </ScrollView>
        </RailPopoverRoster>
    );
});

/** "20 working": every machine's working sessions, read in its own leaf so the list does not re-render. */
const WorkingTotal = React.memo(function WorkingTotal() {
    const total = useMachineWorkingTotal();
    if (total === 0) return null;
    return <Text testID="sidebar-machines-working" style={styles.countsText} numberOfLines={1}>{t('machineDetailPage.work.working', { count: total })}</Text>;
});

const MachinesPopoverSection = React.memo(function MachinesPopoverSection(props: Readonly<{
    section: MachineCollectionSection;
    caption: React.ReactNode;
    thisComputerMachineId: string | null;
    onOpenRow: (row: MachineCollectionRow, identity?: readonly unknown[]) => void;
}>) {
    const { section } = props;
    // An empty group is not drawn: the glance lists machines, not the places they could be.
    if (section.rows.length === 0) return null;
    return (
        <>
            {section.title || props.caption ? <CollectionListGroupLabel title={section.title ?? ''} trailing={props.caption ?? undefined} /> : null}
            {section.rows.map(row => (
                <MachinesPopoverRow
                    key={machineCollectionRowKey(row)}
                    row={row}
                    thisComputer={row.kind === 'machine' && row.machineId === props.thisComputerMachineId}
                    onOpen={props.onOpenRow}
                />
            ))}
        </>
    );
});

/**
 * One machine: its mark, its name and a quiet tag (This computer, a created machine's power), and on
 * the right what it is doing — "3 working" / "No work" — or, when it is not online, one quiet line
 * saying why ("Offline · last seen yesterday", "Asleep · …"), which closes the name's line, or sits under it
 * when the two cannot share the line.
 */
const MachinesPopoverRow = React.memo(function MachinesPopoverRow(props: Readonly<{
    row: MachineCollectionRow;
    thisComputer: boolean;
    onOpen: (row: MachineCollectionRow, identity?: readonly unknown[]) => void;
}>) {
    const { theme } = useUnistyles();
    const { row, onOpen } = props;
    const machineId = row.kind === 'machine' ? row.machineId : row.enrolledMachineId ?? '';
    const working = useMachineWorkingCount({ serverId: row.serverId, machineId });
    const onlineWord = t('settingsOverview.machineOnline');
    const tag = props.thisComputer
        ? t('settingsMachines.thisComputerTitle')
        : row.online && row.presence !== onlineWord ? row.presence : null;
    const detail = row.reason
        ?? (row.online ? (working > 0 ? t('machineDetailPage.work.working', { count: working }) : t('machineDetailPage.work.none')) : row.presence);
    const id = row.kind === 'managed' ? row.managedId : row.machineId;
    // The mark and the name are where the page header's mark and name travel from (MPG-32): measured on press.
    const markRef = React.useRef<View>(null);
    const nameRef = React.useRef<React.ComponentRef<typeof Text>>(null);
    const onPress = React.useCallback(() => onOpen(row, [markRef.current, nameRef.current]), [onOpen, row]);
    const setting = useMachineSummarySettingValue();
    const availability = useMachineResourceSummary({ serverId: row.serverId, machineId });
    // Every online machine carries its strip under the name; a machine that does not report says why there.
    const strip = row.online && setting.metrics.length > 0 ? (
        availability?.kind === 'not_reported' ? (
            <Text style={styles.quietLine} numberOfLines={1}>{t(availability.reason === 'older_happier' ? 'machineSummary.olderHappierShort' : 'machineSummary.unsupported')}</Text>
        ) : (
            <MachineSummaryStrip testID={`sidebar-machines-row.${row.serverId}.${id}.summary`}
                availability={availability} style={setting.style} metrics={setting.metrics} layout="under" />
        )
    ) : undefined;
    // An offline or away machine says why in one quiet line under its name, where an online row has its strip
    // (MPG-18), so a long "last seen" sentence never wraps the name's line.
    const awayLine = row.online ? undefined : <Text style={styles.quietLine} numberOfLines={1}>{detail}</Text>;
    return (
        <Item
            testID={`sidebar-machines-row.${row.serverId}.${id}`}
            title={row.title}
            titleRef={nameRef}
            // A roster row keeps the name on its one line, as the list column does (lab `rm` P).
            titleLines={1}
            subtitle={awayLine ?? strip}
            titleAccessory={tag ? <Text style={styles.tag} numberOfLines={1}>{tag}</Text> : undefined}
            // What it is doing (or why it is away) closes the name's line, level with the name, never centred
            // against the strip beneath it (lab `rm` P).
            titleMeta={awayLine ? undefined : <Text style={styles.rowMeta} numberOfLines={1}>{detail}</Text>}
            accessibilityLabel={[row.title, tag, detail].filter(Boolean).join(', ')}
            icon={(
                <View ref={markRef} collapsable={false}>
                    <HappierCollectionListMark>
                        <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                </View>
            )}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={onPress}
        />
    );
});

/** A Home this device is signed out of: why its machines are missing, and the way back in. */
function SignedOutHomeLine(props: Readonly<{ serverId: string; home: string; onSignIn: (serverId: string) => void }>) {
    return (
        <View testID={`sidebar-machines-signed-out.${props.serverId}`} style={styles.signedOut}>
            <Text style={styles.signedOutText} numberOfLines={2}>{t('sidebarFooter.machinesHomeSignedOut', { home: props.home })}</Text>
            <RoundButton
                testID={`sidebar-machines-sign-in.${props.serverId}`}
                size="small"
                display="secondary"
                title={t('settingsOverview.signIn')}
                onPress={() => props.onSignIn(props.serverId)}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    counts: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        flexShrink: 1,
        minWidth: 0,
    },
    countsText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    allMachines: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        flexShrink: 0,
    },
    allMachinesText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    rowMeta: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    quietLine: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    tag: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    signedOut: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    signedOutText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        flex: 1,
        color: theme.colors.text.secondary,
    },
    invitation: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
    },
}));
