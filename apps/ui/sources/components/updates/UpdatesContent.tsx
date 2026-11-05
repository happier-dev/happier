import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import type { UpdatesContentModel, UpdatesGroup } from '@/updates/useUpdatesContentModel';

import { describeUpdatesHeader } from './describeUpdatesSummary';
import { describeUpdatesGroupRow, partitionUncheckedItems, partitionUpdatesPageGroups, updatesGroupTitle } from './describeUpdatesGroupRow';
import { UpdateRow } from './UpdateRow';
import { UpdatesPopoverRows } from './UpdatesPopoverRows';
import { UpdatesTextButton } from './UpdatesTextButton';

type Presentation = 'popover' | 'screen';

function groupWhere(group: UpdatesGroup): string {
    if (group.kind === 'app') return t('updates.sections.thisApp');
    if (group.kind === 'thisComputer') return group.machineName ?? t('updates.sections.thisComputer');
    return group.machineName ?? '';
}

/** Check for updates, and the one batch action: the screen puts them in the page header. */
const SummaryActions = React.memo(function SummaryActions(props: Readonly<{ model: UpdatesContentModel; presentation: Presentation }>) {
    const { model } = props;
    const header = describeUpdatesHeader(model.summary, model.batch, model);
    return (
        <View style={styles.headerActions}>
            {!model.batch && props.presentation === 'screen' ? (
                <UpdatesTextButton label={t('updates.action.checkNow')} onPress={model.checkNow} testID="updates.checkNow" />
            ) : null}
            {header.showUpdateAll ? (
                <RoundButton title={t('updates.action.updateAll')} onPress={() => void model.updateAll()} testID="updates.updateAll" />
            ) : header.showStop ? (
                <UpdatesTextButton label={t('updates.action.stopAfterThis')} onPress={model.stopAfterCurrent} testID="updates.stopAfterThis" />
            ) : null}
        </View>
    );
});

/**
 * The page's present tense, under its purpose line: what the updates owner says now ("1 update
 * available") and when it last knew ("Checked 10:42"). One polite live region; percent ticks live in
 * the rows. It keeps two lines of height in every state so nothing below it moves.
 */
const ScreenSummary = React.memo(function ScreenSummary(props: Readonly<{ model: UpdatesContentModel }>) {
    const { model } = props;
    const header = describeUpdatesHeader(model.summary, model.batch, model);
    return (
        <View style={styles.screenSummary} accessibilityLiveRegion="polite" testID="updates.summary">
            <Text variant="label" style={styles.screenSummaryTitle} accessibilityRole="header" testID="updates.summary.title">
                {header.title}
            </Text>
            <Text variant="body" style={[styles.screenSummaryMeta, Typography.tabular()]} testID="updates.summary.meta">
                {header.meta}
            </Text>
        </View>
    );
});

/** The popover's summary row: its title, its meta, and the batch actions beside them. */
const SummaryHeader = React.memo(function SummaryHeader(props: Readonly<{ model: UpdatesContentModel }>) {
    const { model } = props;
    const header = describeUpdatesHeader(model.summary, model.batch, model);
    return (
        <View style={[styles.header, styles.headerCompact]} testID="updates.summary">
            {/*
              * One polite live region for the whole status: a completion or failure changes the
              * title, so it is announced; percent ticks live in the rows and never reach it. The
              * block's minimum height (one title line + one meta line) keeps the list from jumping.
              */}
            <View
                style={[styles.headerText, styles.headerTextCompact]}
                accessibilityLiveRegion="polite"
            >
                <Text
                    style={styles.headerTitle}
                    accessibilityRole="header"
                    numberOfLines={2}
                    testID="updates.summary.title"
                >
                    {header.title}
                </Text>
                <Text style={[styles.headerMeta, Typography.tabular()]} testID="updates.summary.meta">
                    {header.meta}
                </Text>
            </View>
            {/* No page header scopes these here: the popover is dense. */}
            <RoundButtonSizeScope size="small"><SummaryActions model={model} presentation="popover" /></RoundButtonSizeScope>
        </View>
    );
});

const UpdatesGroupSection = React.memo(function UpdatesGroupSection(props: Readonly<{
    model: UpdatesContentModel;
    group: UpdatesGroup;
    secondaryActions: boolean;
}>) {
    const { theme } = useUnistyles();
    const { model, group } = props;
    const where = groupWhere(group);
    const skipVersion = group.kind === 'app' ? model.skipAppVersion : null;
    const parts = React.useMemo(() => partitionUncheckedItems(group.items), [group.items]);
    return (
        <View testID={`updates.section.${group.id}`}>
            <ItemGroup title={updatesGroupTitle(group)}>
                {parts.rows.map((item) => (
                    <UpdateRow
                        key={item.id}
                        item={item}
                        where={where}
                        presentation="screen"
                        secondaryAction={props.secondaryActions}
                        onRun={model.runItem}
                        onLongPress={skipVersion ?? undefined}
                        isThisComputer={group.kind === 'thisComputer'}
                        sessionsRunning={item.machineId != null && model.sessionsRunningOn.has(item.machineId)}
                    />
                ))}
                {parts.unchecked.length > 0 ? (
                    <CountedDisclosureItem
                        testID={`updates.section.${group.id}.unchecked`}
                        title={t('updates.row.uncheckedTools', { count: parts.unchecked.length })}
                        subtitle={parts.unchecked.map((item) => item.title).join(', ')}
                        icon={<Icon name="question" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                        showDivider={skipVersion != null || group.kind === 'app'}
                    >
                        {parts.unchecked.map((item) => (
                            <UpdateRow
                                key={item.id}
                                item={item}
                                where={where}
                                presentation="screen"
                                secondaryAction={props.secondaryActions}
                                onRun={model.runItem}
                                isThisComputer={group.kind === 'thisComputer'}
                                sessionsRunning={item.machineId != null && model.sessionsRunningOn.has(item.machineId)}
                            />
                        ))}
                    </CountedDisclosureItem>
                ) : null}
                {skipVersion ? (
                    <Item
                        title={t('updates.action.skipVersion')}
                        icon={<Icon name="x" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                        onPress={skipVersion}
                        showChevron={false}
                        testID="updates.skipVersion"
                    />
                ) : null}
                {group.kind === 'app' ? (
                    <Item
                        title={t('updates.action.whatsNew')}
                        icon={<Icon name="sparkle" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                        onPress={model.openWhatsNew}
                        testID="updates.whatsNew"
                    />
                ) : null}
            </ItemGroup>
        </View>
    );
});

/**
 * Machines that share one state (offline, or reachable with nothing to do) share one quiet section: a
 * row that says how many, opening to one line per machine (the popover's row words), instead of one
 * identical section each.
 */
const MachineFoldSection = React.memo(function MachineFoldSection(props: Readonly<{
    kind: 'offline' | 'quiet';
    groups: readonly UpdatesGroup[];
}>) {
    const { theme } = useUnistyles();
    const lastSeenAt = props.groups.reduce<number | null>((latest, group) => (
        group.lastSeenAt != null && group.lastSeenAt > (latest ?? 0) ? group.lastSeenAt : latest
    ), null);
    const offline = props.kind === 'offline';
    return (
        <ItemGroup
            title={offline ? t('updates.sections.offlineTitle') : t('updates.sections.quietTitle')}
            description={offline ? t('updates.sections.offlineDescription') : undefined}
        >
            <CountedDisclosureItem
                testID={`updates.${props.kind}`}
                title={t('updates.sections.offlineMachines', { count: props.groups.length })}
                // The names live one tap away; the row says how fresh the newest of them is.
                subtitle={offline && lastSeenAt != null ? t('status.lastSeen', { time: formatLastSeen(lastSeenAt) }) : undefined}
                icon={<Icon name="desktop" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
            >
                {props.groups.map((group, index) => (
                    <Item
                        key={group.id}
                        testID={`updates.${props.kind}.${group.id}`}
                        title={updatesGroupTitle(group)}
                        subtitle={describeUpdatesGroupRow(group).status}
                        density="compact"
                        mode="info"
                        showChevron={false}
                        showDivider={index < props.groups.length - 1}
                    />
                ))}
            </CountedDisclosureItem>
        </ItemGroup>
    );
});

/**
 * Updates in two densities, exactly like the inbox: `popover` (sidebar pill) and `screen`
 * (Settings › Updates). One list — This app → This computer → other machines — whose groups and
 * rows never re-sort by state, so nothing jumps while updates land.
 */
export const UpdatesContent = React.memo(function UpdatesContent(props: Readonly<{
    model: UpdatesContentModel;
    presentation: Presentation;
}>) {
    const { model, presentation } = props;
    const compact = presentation === 'popover';
    // Only one filled button is the primary: when "Update all" shows, row buttons are secondary.
    const secondaryActions = model.summary.actionableCount >= 2 && !model.batch;
    // The calm empty state only when every row proved it is current (the header's own decision).
    const pageGroups = React.useMemo(() => partitionUpdatesPageGroups(model.groups), [model.groups]);
    const nothingToShow = compact
        && describeUpdatesHeader(model.summary, model.batch, model).empty
        && !model.whatsNewUnread;

    return (
        <View style={[styles.content, compact ? styles.compactContent : null]} testID={`updates.content.${presentation}`}>
            {nothingToShow ? (
                <View style={[styles.empty, compact ? styles.emptyCompact : null]}>
                    <EmptyState
                        testID="updates.empty"
                        iconName="check-circle"
                        title={describeUpdatesHeader(model.summary, model.batch, model).title}
                        subtitle={model.summary.status === 'unknown'
                            ? t('updates.summary.unknownDescription')
                            : model.summary.status === 'offline'
                                ? t('updates.summary.offlineDescription')
                                : t('updates.summary.upToDateDescription')}
                        action={<UpdatesTextButton label={t('updates.action.checkNow')} onPress={model.checkNow} testID="updates.empty.checkNow" />}
                    />
                </View>
            ) : (
                compact ? (
                    <>
                        <SummaryHeader model={model} />
                        <UpdatesPopoverRows model={model} />
                    </>
                ) : (
                    <>
                        <SettingsPageHeader
                            description={t('updates.pageDescription')}
                            actions={<SummaryActions model={model} presentation={presentation} />}
                            details={<ScreenSummary model={model} />}
                            detailsPlacement="column"
                        />
                        {pageGroups.sections.map((group) => (
                            <UpdatesGroupSection
                                key={group.id}
                                model={model}
                                group={group}
                                secondaryActions={secondaryActions}
                            />
                        ))}
                        {pageGroups.quiet.length > 0 ? <MachineFoldSection kind="quiet" groups={pageGroups.quiet} /> : null}
                        {pageGroups.offline.length > 0 ? <MachineFoldSection kind="offline" groups={pageGroups.offline} /> : null}
                    </>
                )
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    content: {
        width: '100%',
        paddingBottom: theme.space.s24,
    },
    // The popover's rows and footer carry the menu rhythm (`MENU_ROW_METRICS`); nothing extra below.
    compactContent: {
        paddingBottom: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    // The summary line starts on the menu rows' text edge and sits one menu rhythm above them.
    headerCompact: {
        paddingHorizontal: MENU_ROW_METRICS.insetPx + MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: MENU_ROW_METRICS.sectionPaddingVerticalPx + MENU_ROW_METRICS.paddingVerticalPx,
        paddingBottom: MENU_ROW_METRICS.paddingVerticalPx,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
        gap: theme.space.s2,
    },
    // One title line + one meta line: the floor every state lays out on.
    headerTextCompact: {
        minHeight: Platform.select({ ios: 19, default: 18 }) + 2 + 16,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    headerTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
    headerMeta: {
        ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }),
        color: theme.colors.text.secondary,
    },
    // Two lines tall in every state (title + meta), so a changing status never moves the sections.
    screenSummary: {
        minHeight: 20 + 18,
        marginTop: theme.space.s8,
    },
    screenSummaryTitle: {
        color: theme.colors.text.primary,
    },
    screenSummaryMeta: {
        color: theme.colors.text.secondary,
    },
    empty: {
        minHeight: 320,
        justifyContent: 'center',
        paddingHorizontal: theme.space.s32,
        paddingVertical: theme.space.s48,
    },
    emptyCompact: {
        minHeight: 220,
        paddingVertical: 34,
    },
}));
