import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ListSection } from '@/components/ui/lists/ListSection';
import { ITEM_ROW_PADDING_HORIZONTAL, resolveItemTextColumnInset } from '@/components/ui/lists/itemDensityMetrics';
import { StatusTransition } from '@/components/ui/motion/StatusTransition';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { isUpdateItemActionable, type UpdateItem } from '@/updates/items/updateItem';
import type { UpdatesContentModel, UpdatesGroup } from '@/updates/useUpdatesContentModel';

import { describeUpdatesHeader } from './describeUpdatesSummary';
import { UpdateRow } from './UpdateRow';
import { UpdatesTextButton } from './UpdatesTextButton';

type Presentation = 'popover' | 'screen';

/** The popover lists only rows that need attention or are in flight; the screen lists every row. */
function needsAttention(item: UpdateItem): boolean {
    return item.state !== 'upToDate' && item.state !== 'offline';
}

/**
 * Every group header is one eyebrow role: an uppercase label, then the machine's own name with its
 * case preserved (hostnames are case-meaningful).
 */
function groupTitle(group: UpdatesGroup): string {
    if (group.kind === 'app') return t('updates.sections.thisApp').toLocaleUpperCase();
    const label = (group.kind === 'thisComputer' ? t('updates.sections.thisComputer') : t('updates.sections.machine')).toLocaleUpperCase();
    return group.machineName ? `${label} · ${group.machineName}` : label;
}

function groupWhere(group: UpdatesGroup): string {
    if (group.kind === 'app') return t('updates.sections.thisApp');
    if (group.kind === 'thisComputer') return group.machineName ?? t('updates.sections.thisComputer');
    return group.machineName ?? '';
}

const SummaryHeader = React.memo(function SummaryHeader(props: Readonly<{ model: UpdatesContentModel; presentation: Presentation }>) {
    const { model } = props;
    const isTablet = useIsTablet();
    const header = describeUpdatesHeader(model.summary, model.batch, model);
    const compact = props.presentation === 'popover';
    // On a phone-width screen the actions sit under the words, so the title and the freshness
    // line (the live region) keep the full width instead of truncating beside two buttons.
    const stacked = !compact && !isTablet;
    // One block, cross-faded on the status settle when the words change; the block's minimum
    // height (one title line + one meta line) keeps the list below from jumping between states.
    const text = (
        // One polite live region for the whole status: a completion or failure changes the title,
        // so it is announced; percent ticks live in the rows and never reach it.
        <View style={styles.headerTextInner} accessibilityLiveRegion="polite">
            <Text
                style={[styles.headerTitle, compact ? styles.headerTitleCompact : null]}
                accessibilityRole="header"
                numberOfLines={2}
                testID="updates.summary.title"
            >
                {header.title}
            </Text>
            <Text
                style={[styles.headerMeta, Typography.tabular()]}
                testID="updates.summary.meta"
            >
                {header.meta}
            </Text>
        </View>
    );
    return (
        <View style={[styles.header, compact ? styles.headerCompact : styles.headerComfortable, stacked ? styles.headerStacked : null]} testID="updates.summary">
            <View style={[styles.headerText, compact ? styles.headerTextCompact : styles.headerTextComfortable, stacked ? styles.headerTextStacked : null]}>
                <StatusTransition transitionKey={`${header.title}\u0000${header.meta}`} fromScale={1} sizing={text}>
                    {text}
                </StatusTransition>
            </View>
            <View accessibilityState={{ busy: Boolean(model.batch) || model.summary.runningCount > 0 || model.checking }} style={[styles.headerActions, stacked ? styles.headerActionsStacked : null]}>
                {model.batch || model.summary.runningCount > 0 ? <ActivitySpinner size={16} testID="updates.updateAll.spinner" /> : null}
                {!model.batch && props.presentation === 'screen' ? (
                    <UpdatesTextButton label={t('updates.action.checkNow')} onPress={model.checkNow} busy={model.checking} testID="updates.checkNow" />
                ) : null}
                {header.showUpdateAll ? (
                    <RoundButton size="small" title={t('updates.action.updateAll')} onPress={() => void model.updateAll()} testID="updates.updateAll" />
                ) : header.showStop ? (
                    <UpdatesTextButton label={t('updates.action.stopAfterThis')} onPress={model.stopAfterCurrent} testID="updates.stopAfterThis" />
                ) : null}
            </View>
        </View>
    );
});

const UpdatesGroupSection = React.memo(function UpdatesGroupSection(props: Readonly<{
    model: UpdatesContentModel;
    group: UpdatesGroup;
    presentation: Presentation;
    secondaryActions: boolean;
    spacing: 'following' | 'separated' | undefined;
}>) {
    const { theme } = useUnistyles();
    const { model, group, presentation } = props;
    const compact = presentation === 'popover';
    const visibleItems = compact ? group.items.filter(needsAttention) : group.items;
    const hiddenCount = group.items.length - visibleItems.length;
    const waitingOffline = !group.online ? group.items.filter((item) => item.latestVersion != null && item.currentVersion !== item.latestVersion).length : 0;
    const appGroup = group.kind === 'app';
    // Stable while an app update moves through its states, so the popover does not shrink mid-update.
    const appItem = group.items[0];
    const appUpdateInFlight = appItem != null && (isUpdateItemActionable(appItem) || appItem.state === 'running' || appItem.state === 'ready' || appItem.state === 'failed');
    const showWhatsNew = appGroup && (!compact || model.whatsNewUnread || appUpdateInFlight);

    if (compact && visibleItems.length === 0 && !(appGroup && model.whatsNewUnread) && waitingOffline === 0) return null;

    const where = groupWhere(group);
    const skipVersion = appGroup && !compact ? model.skipAppVersion : null;
    return (
        <ListSection
            namespace="updates"
            id={group.id}
            title={groupTitle(group)}
            preserveTitleCase
            surface={compact ? 'flat' : 'grouped'}
            spacing={props.spacing}
            headerAction={!group.online ? <Text style={styles.groupMeta}>{t('updates.offline')}</Text> : undefined}
        >
            {compact && !group.online ? (
                <Text style={styles.collapsedLine}>{t('updates.row.waitingOffline', { count: waitingOffline })}</Text>
            ) : (
                visibleItems.map((item) => (
                    <UpdateRow
                        key={item.id}
                        item={item}
                        where={where}
                        presentation={presentation}
                        secondaryAction={props.secondaryActions}
                        onRun={model.runItem}
                        onLongPress={skipVersion ?? undefined}
                        isThisComputer={group.kind === 'thisComputer'}
                        sessionsRunning={item.machineId != null && model.sessionsRunningOn.has(item.machineId)}
                    />
                ))
            )}
            {skipVersion ? (
                <Item
                    title={t('updates.action.skipVersion')}
                    icon={<Icon name="x" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                    onPress={skipVersion}
                    showChevron={false}
                    testID="updates.skipVersion"
                />
            ) : null}
            {showWhatsNew ? (
                <Item
                    title={t('updates.action.whatsNew')}
                    density={compact ? 'compact' : undefined}
                    icon={<Icon name="sparkle" size={compact ? ICON_SIZE.sm : ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                    onPress={model.openWhatsNew}
                    testID="updates.whatsNew"
                />
            ) : null}
            {compact && group.online && hiddenCount > 0 && visibleItems.length > 0 ? (
                <Text style={styles.collapsedLine}>{t('updates.row.othersUpToDate', { count: hiddenCount })}</Text>
            ) : null}
        </ListSection>
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
    const { theme } = useUnistyles();
    const { model, presentation } = props;
    const compact = presentation === 'popover';
    // Only one filled button is the primary: when "Update all" shows, row buttons are secondary.
    const secondaryActions = model.summary.actionableCount >= 2 && !model.batch;
    // The calm empty state only when every row proved it is current (the header's own decision).
    const nothingToShow = compact
        && describeUpdatesHeader(model.summary, model.batch, model).empty
        && !model.whatsNewUnread;

    return (
        <View style={[styles.content, compact ? styles.compactContent : null]} testID={`updates.content.${presentation}`}>
            {nothingToShow ? (
                <View style={[styles.empty, compact ? styles.emptyCompact : null]}>
                    <EmptyState
                        testID="updates.empty"
                        icon={(
                            <View style={styles.emptyIconSurface}>
                                <Icon name="check-circle" size={25} color={theme.colors.state.success.foreground} />
                            </View>
                        )}
                        title={describeUpdatesHeader(model.summary, model.batch, model).title}
                        subtitle={model.summary.status === 'unknown'
                            ? t('updates.summary.unknownDescription')
                            : model.summary.status === 'offline'
                                ? t('updates.summary.offlineDescription')
                                : t('updates.summary.upToDateDescription')}
                        action={<UpdatesTextButton label={t('updates.action.checkNow')} onPress={model.checkNow} busy={model.checking} testID="updates.empty.checkNow" />}
                    />
                </View>
            ) : (
                <>
                    <SummaryHeader model={model} presentation={presentation} />
                    {model.groups.map((group, index) => (
                        <UpdatesGroupSection
                            key={group.id}
                            model={model}
                            group={group}
                            presentation={presentation}
                            secondaryActions={secondaryActions}
                            spacing={index === 0 ? undefined : compact ? 'following' : 'separated'}
                        />
                    ))}
                    {!compact ? <Text style={styles.footer}>{t('updates.footer')}</Text> : null}
                </>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    content: {
        width: '100%',
        paddingBottom: 24,
    },
    compactContent: {
        paddingBottom: 14,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.md,
    },
    headerCompact: {
        paddingHorizontal: theme.margins.md,
        paddingTop: theme.margins.md,
        paddingBottom: theme.margins.sm,
    },
    headerComfortable: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 16,
        paddingBottom: 4,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    // One title line + one meta line: the floor every state lays out on.
    headerTextCompact: {
        minHeight: Platform.select({ ios: 19, default: 18 }) + 2 + 16,
    },
    headerTextComfortable: {
        minHeight: Platform.select({ ios: 22, default: 21 }) + 2 + 16,
    },
    headerTextInner: {
        alignSelf: 'stretch',
        gap: 2,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.md,
    },
    headerStacked: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: theme.margins.sm,
    },
    headerTextStacked: {
        flex: 0,
    },
    headerActionsStacked: {
        justifyContent: 'flex-end',
    },
    groupMeta: {
        ...Typography.default(),
        fontSize: Platform.select({ ios: 13, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
        color: theme.colors.text.tertiary,
    },
    headerTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 21 }),
    },
    headerTitleCompact: {
        fontSize: Platform.select({ ios: 14, default: 13 }),
        lineHeight: Platform.select({ ios: 19, default: 18 }),
    },
    headerMeta: {
        ...Typography.timestamp(),
        color: theme.colors.text.secondary,
    },
    // Collapsed lines read as part of the rows above: they start on the rows' text column.
    collapsedLine: {
        ...Typography.default(),
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: 16,
        color: theme.colors.text.secondary,
        paddingLeft: resolveItemTextColumnInset('compact'),
        paddingRight: ITEM_ROW_PADDING_HORIZONTAL.compact,
        paddingVertical: 6,
    },
    footer: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
    },
    empty: {
        minHeight: 320,
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingVertical: 48,
    },
    emptyCompact: {
        minHeight: 220,
        paddingVertical: 34,
    },
    emptyIconSurface: {
        width: 52,
        height: 52,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.state.success.background,
        borderWidth: 1,
        borderColor: theme.colors.state.success.border,
    },
}));
