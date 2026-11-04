import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import type { MachineGuardActivityListV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { formatMachineBytes, machineBytesParts } from '@/components/machines/vitals/machineVitalsPresentation';
import { VitalsSheet, VitalsSubLine, VitalsTile, VitalsValue } from '@/components/machines/vitals/VitalsSheet';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY, type MachineGuardActivityQuery } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineGuardActivity } from '@/sync/domains/machines/guard/useMachineGuardView';
import { getPreferredLanguage, t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { MachineFreshnessChip } from '@/components/machines/page/MachineFreshnessChip';
import { useGuardActivityFreshness } from '../useGuardFreshness';
import { groupGuardActivityByDay, summarizeGuardActivity } from './guardActivityPresentation';
import { MachineActivityRow } from './MachineActivityRow';
import { useGuardWayBack } from './useGuardWayBack';

type Filter = MachineGuardActivityQuery['filter'];
type Range = MachineGuardActivityQuery['range'];
const FILTERS: readonly Filter[] = ['all', 'stopped', 'cleaned_up', 'needs_look'];
const RANGES: readonly Range[] = ['today', '7d', '30d'];
const LONGER: Readonly<Record<Range, Range | null>> = { today: '7d', '7d': '30d', '30d': null };

/**
 * Everything Happier did on the machine by itself (lab `rg` G7 / G7p / G7s): what it freed, what sits
 * in Trash and what needs a look; filters with their counts and a range; the receipts by day, each with
 * its way back. Receipts are the daemon's (kept 30 days); a shared machine's recipient sees their own
 * and only a count of other people's.
 */
export const MachineActivityPage = React.memo(function MachineActivityPage(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    onBack: () => void;
    barAccessoryShown: boolean;
}>) {
    const language = usePreferredLanguage();
    const [filter, setFilter] = React.useState<Filter>(DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY.filter);
    const [range, setRange] = React.useState<Range>(DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY.range);
    const layout = useMachineTabCompactLayout();
    // The summary and the filter counts always describe the whole range; the list follows the filter.
    const all = useMachineGuardActivity({ machineId: props.machineId, serverId: props.serverId, range, filter: 'all' });
    const filtered = useMachineGuardActivity({ machineId: props.machineId, serverId: props.serverId, range, filter });
    const wayBack = useGuardWayBack({ serverId: props.serverId, machineId: props.machineId });
    const selected = filter === 'all' ? all : filtered;
    const { list, status } = selected;
    const freshness = useGuardActivityFreshness(selected, props);
    const groups = React.useMemo(() => list ? groupGuardActivityByDay(list.entries) : [], [language, list]);
    const counts = all.list?.counts ?? null;
    const total = counts ? counts.stopped + counts.cleanedUp + counts.needsLook : null;
    // Nothing automatic in the whole range (lab `rg` G7s 1): one empty state says what will be listed here; no zeroed
    // summary and no filters with nothing to filter. "Show earlier" stays, since the range may not be the whole log.
    const nothingYet = total === 0;
    const filterCount = (id: Filter) => !counts ? null : id === 'all' ? total : id === 'stopped' ? counts.stopped : id === 'cleaned_up' ? counts.cleanedUp : counts.needsLook;

    return (
        <View testID="machine-activity-page" onLayout={layout.onLayout}>
            <MachineTabSubHead title={t('machineGuard.activity.title')}
                back={{ label: t('machineGuard.activity.back'), onPress: props.onBack, testID: 'machine-activity-back' }}
                aside={layout.compact ? null : t('machineGuard.activity.pageAccessory', { machine: props.machineName })}>
                <View style={styles.freshness}>
                    <MachineFreshnessChip testID={`machine-activity-${freshness.kind}`} freshness={freshness} />
                </View>
            </MachineTabSubHead>
            {all.list && !nothingYet ? <ActivitySummary list={all.list} /> : null}
            {nothingYet ? null : <ItemGroup surface="none" header="none">
                <View style={[styles.controls, layout.compact ? styles.controlsCompact : null]}>
                    {layout.compact ? (
                        <PolicyValueSelect testID="machine-activity-filter" label={t('machineGuard.activity.filters.label')}
                            value={t(`machineGuard.activity.filters.${filter}`)} selectedId={filter}
                            choices={FILTERS.map(id => ({ id, title: `${t(`machineGuard.activity.filters.${id}`)}${filterCount(id) === null ? '' : ` · ${filterCount(id)}`}` }))}
                            onSelect={id => setFilter(id as Filter)} />
                    ) : (
                        <SegmentedTabBar<Filter> role="radiogroup" segmentSizing="content"
                            accessibilityLabel={t('machineGuard.activity.filters.label')} testIDPrefix="machine-activity-filter"
                            tabs={FILTERS.map(id => { const count = filterCount(id); return { id, label: t(`machineGuard.activity.filters.${id}`), ...(count === null ? {} : { count: count.toLocaleString(getPreferredLanguage()) }) }; })}
                            activeTabId={filter} onSelectTab={setFilter} />
                    )}
                    <PolicyValueSelect testID="machine-activity-range" label={t('machineGuard.activity.ranges.label')}
                        value={t(`machineGuard.activity.ranges.${range}`)} selectedId={range}
                        choices={RANGES.map(id => ({ id, title: t(`machineGuard.activity.ranges.${id}`) }))}
                        onSelect={id => setRange(id as Range)} />
                </View>
            </ItemGroup>}
            {nothingYet ? (
                <ItemGroup>
                    <SurfaceStateCard testID="machine-activity-nothing-yet" kind="empty" size="details" iconName="clock" replacesContent
                        title={t(`machineGuard.activity.emptyTitle.${range}`, { machine: props.machineName })}
                        reason={t('machineGuard.activity.emptyBody')}
                        // It points back to where entries come from rather than adding one: the quiet tone (lab G7s).
                        action={{ label: t('machineGuard.activity.reviewRules'), onPress: props.onBack, invitation: false, testID: 'machine-activity-review-rules' }} />
                </ItemGroup>
            ) : !list ? (
                status === 'error' || status === 'not_reported' ? (
                    <ItemGroup>
                        <SurfaceStateCard testID="machine-activity-error" kind="error" size="line" title={t('machineGuard.activity.error')}
                            action={selected.offline ? undefined : { label: t('machineGuard.tryAgain'), onPress: selected.retry }} />
                    </ItemGroup>
                ) : all.offline ? (
                    <ItemGroup>
                        <SurfaceStateCard testID="machine-activity-offline" kind="unavailable" size="line"
                            title={t('machineGuard.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineGuard.states.offlineReason')} />
                    </ItemGroup>
                ) : <ActivityLoading />
            ) : groups.length === 0 ? (
                <ItemGroup>
                    <SurfaceStateCard testID="machine-activity-empty" kind="empty" size="line" iconName="clock"
                        title={filter === 'all' && total === 0 ? t('machineGuard.activity.empty', { machine: props.machineName }) : t('machineGuard.activity.noMatches')} />
                </ItemGroup>
            ) : groups.map(group => (
                <ItemGroup key={group.dayStart} title={formatActivityDay(group.dayStart)}
                    titleAccessory={<Text style={styles.dayAccessory}>{[
                        ...(group.freedMemoryBytes > 0 ? [t('machineGuard.activity.dayFreed', { amount: formatMachineBytes(group.freedMemoryBytes, 'memory') })] : []),
                        ...(group.inTrashBytes > 0 ? [t('machineGuard.activity.dayInTrash', { amount: formatMachineBytes(group.inTrashBytes, 'storage') })] : []),
                    ].join(' · ')}</Text>}>
                    {group.entries.map((entry, index) => (
                        <MachineActivityRow key={entry.id} entry={entry} pendingId={wayBack.pendingId} onWayBack={wayBack.run}
                            readOnly={all.offline} showDivider={index < group.entries.length - 1} />
                    ))}
                </ItemGroup>
            ))}
            {list ? (
                <ItemGroup surface="none" header="none">
                    <View style={styles.footer}>
                        {LONGER[range] ? <TextLinkButton testID="machine-activity-earlier" tone="strong" label={t('machineGuard.activity.showEarlier')}
                            onPress={() => setRange(LONGER[range]!)} /> : null}
                        <Text style={styles.footerText}>{t('machineGuard.activity.keptFor', { machine: props.machineName })}</Text>
                    </View>
                    {list.counts.others > 0 ? <Text style={styles.footerText}>{t('machineGuard.activity.others', { count: list.counts.others })}</Text> : null}
                </ItemGroup>
            ) : null}
        </View>
    );
});

/** "Today", "Yesterday", "Monday, October 6". */
function formatActivityDay(dayStart: number): string {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const delta = Math.round((today.getTime() - dayStart) / 86_400_000);
    if (delta === 0) return t('machineGuard.activity.today');
    if (delta === 1) return t('machineGuard.activity.yesterday');
    return new Intl.DateTimeFormat(getPreferredLanguage(), { weekday: 'long', month: 'long', day: 'numeric' }).format(dayStart);
}

/**
 * Memory freed · In Trash · Needs a look, over the whole range (lab `rg` G7), drawn by the machine page's one stat
 * tile owner (`VitalsSheet`): label, value with its unit, one quiet line. Needs a look takes amber only above zero.
 */
function ActivitySummary(props: Readonly<{ list: MachineGuardActivityListV1 }>) {
    const { theme } = useUnistyles();
    const { freedBytes: freed, inTrashBytes: inTrash, trashItems } = summarizeGuardActivity(props.list.entries);
    const freedParts = machineBytesParts(freed, 'memory');
    const trashParts = machineBytesParts(inTrash, 'storage');
    const needsLook = props.list.counts.needsLook;
    return (
        <VitalsSheet testID="machine-activity-summary" columns={3}>
            {[
                <VitalsTile key="freed" label={t('machineGuard.activity.tiles.memoryFreed')}
                    value={<VitalsValue value={freedParts.value} unit={freedParts.unit} />}
                    sub={<VitalsSubLine>{t('machineGuard.activity.tiles.stops', { count: props.list.counts.stopped })}</VitalsSubLine>} />,
                <VitalsTile key="trash" label={t('machineGuard.activity.tiles.inTrash')}
                    value={<VitalsValue value={trashParts.value} unit={trashParts.unit} />}
                    sub={trashItems > 0 ? <VitalsSubLine>{t('machineGuard.activity.kinds.trashMoved', { count: trashItems })}</VitalsSubLine> : undefined} />,
                <VitalsTile key="look" label={t('machineGuard.activity.tiles.needsLook')}
                    value={<VitalsValue value={needsLook.toLocaleString(getPreferredLanguage())}
                        color={needsLook > 0 ? theme.colors.state.attention.textForeground : undefined} />}
                    sub={needsLook === 0 ? <VitalsSubLine>{t('machineGuard.activity.tiles.needsLookNone')}</VitalsSubLine> : undefined} />,
            ]}
        </VitalsSheet>
    );
}

function ActivityLoading() {
    return (
        <ItemGroup>
            <View testID="machine-activity-loading" accessibilityLabel={t('machineGuard.activity.loading')} accessibilityRole="progressbar">
                <ItemLoadStateRows state={{ kind: 'loading' }} rows={4} lines={2} />
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    freshness: {
        marginTop: theme.space.s8,
        alignItems: 'flex-start',
    },
    controls: {
        // One toolbar gap under the summary sheet (lab `rg` G7).
        marginTop: theme.space.s12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    controlsCompact: {
        justifyContent: 'flex-start',
    },
    dayAccessory: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    footer: {
        // The footer is its own block: one section gap under the day sheets, as every page block has.
        marginTop: PAGE_LIST_METRICS.sectionGapPx,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
    },
    footerText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
}));
