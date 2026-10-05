import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { usePaneHeaderSlotContent, type PaneHeaderLineSegment } from '@/components/appShell/panes/paneHeaderSlot';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import {
    TranscriptNavigationEntryList,
    type TranscriptNavigationNewestTurnState,
    type TranscriptNavigationSessionStart,
} from './TranscriptNavigationEntryList';
import {
    filterTranscriptNavigationEntries,
    isTranscriptNavigationFilterPartial,
    resolveTranscriptNavigationFilterChips,
    summarizeTranscriptNavigationEntries,
    type TranscriptNavigationFilter,
} from './transcriptNavigationFilters';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryPressHandler,
} from './transcriptNavigationTypes';

export type TranscriptNavigationPanelProps = Readonly<{
    sessionId: string;
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    /** The turns on screen in the transcript now. */
    visibleEntryIds?: readonly string[];
    /** What the session is doing with its newest turn (canonical awareness). */
    newestTurn?: TranscriptNavigationNewestTurnState;
    /** Every earlier turn is listed: filters are complete and the list ends at the session start. */
    historyComplete?: boolean;
    /** The reader's "Load earlier turns". */
    onLoadEarlier?: () => void;
    loadingEarlier?: boolean;
    sessionStart?: TranscriptNavigationSessionStart | null;
    /** The session is unreachable: the list is last-known, as of this moment. */
    offline?: Readonly<{ asOfMs: number | null; reason: string }> | null;
    onEntryPress: TranscriptNavigationEntryPressHandler;
    onRequestClose?: () => void;
    /** True while the session transcript has not produced its first page yet. */
    isLoading?: boolean;
    testIDPrefix?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
    filters: {
        paddingHorizontal: 16,
        paddingBottom: 8,
        alignItems: 'flex-start',
    },
    freshness: {
        paddingHorizontal: 16,
        paddingBottom: 6,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    lineState: {
        paddingHorizontal: 16,
    },
}));

function defaultTestIDPrefix(prefix: string | undefined): string {
    return prefix && prefix.trim().length > 0 ? prefix.trim() : 'transcript-navigation';
}

const FILTER_LABEL_KEYS = {
    all: 'session.transcriptNavigation.modeAll',
    pinned: 'session.transcriptNavigation.modePinned',
    approvals: 'session.transcriptNavigation.filterApprovals',
    errors: 'session.transcriptNavigation.filterErrors',
} as const;

function headerSegments(params: Readonly<{
    filter: TranscriptNavigationFilter;
    counts: Readonly<Record<TranscriptNavigationFilter, number>>;
    waitingCount: number;
    partial: boolean;
}>): PaneHeaderLineSegment[] {
    const { counts, filter } = params;
    const segments: PaneHeaderLineSegment[] = [];
    if (filter === 'pinned') {
        segments.push(t('session.transcriptNavigation.pinnedCount', { count: counts.pinned }));
    } else if (filter === 'approvals') {
        segments.push(t('session.transcriptNavigation.approvalsCount', { count: counts.approvals }));
    } else if (filter === 'errors') {
        segments.push(t('session.transcriptNavigation.errorsCount', { count: counts.errors }));
    } else {
        segments.push(t('session.transcriptNavigation.turnCount', { count: counts.all }));
    }
    if (params.partial) segments.push(t('session.transcriptNavigation.soFar'));
    if (params.waitingCount > 0 && (filter === 'all' || filter === 'approvals')) {
        segments.push({ text: t('session.transcriptNavigation.waitingCount', { count: params.waitingCount }), attention: true });
    }
    return segments;
}

export const TranscriptNavigationPanel = React.memo((props: TranscriptNavigationPanelProps) => {
    const styles = stylesheet;
    const [filter, setFilter] = React.useState<TranscriptNavigationFilter>('all');
    const testIDPrefix = defaultTestIDPrefix(props.testIDPrefix);
    const historyComplete = props.historyComplete === true;
    const summary = React.useMemo(() => summarizeTranscriptNavigationEntries(props.entries), [props.entries]);
    const entries = React.useMemo(() => filterTranscriptNavigationEntries(props.entries, filter), [filter, props.entries]);
    const partial = React.useMemo(
        () => isTranscriptNavigationFilterPartial({ entries: props.entries, filter, historyComplete }),
        [filter, historyComplete, props.entries],
    );
    const showAll = React.useCallback(() => setFilter('all'), []);

    const chips = resolveTranscriptNavigationFilterChips(summary, filter);
    const chipKey = chips.join('|');
    const tabs = React.useMemo<ReadonlyArray<SegmentedTab<TranscriptNavigationFilter>>>(
        () => (chipKey.split('|') as TranscriptNavigationFilter[]).map((id) => ({
            id,
            label: t(FILTER_LABEL_KEYS[id]),
            count: String(summary.counts[id]),
        })),
        [chipKey, summary],
    );

    // The pane header is the only header (lab N, B21): its live line says how long the session is
    // and what needs you. The filters are one row under it (lab NA), so the header has no trailing action.
    const headerLine = React.useMemo(() => (props.entries.length === 0 ? null : {
        segments: headerSegments({ filter, counts: summary.counts, waitingCount: summary.waitingCount, partial }),
    }), [filter, partial, props.entries.length, summary]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine }), [headerLine]));
    // Loading only ever replaces NOTHING: once entries exist, a background refresh must not
    // erase a list the reader is already using.
    const showLoading = props.isLoading === true && props.entries.length === 0;
    const onLoadEarlier = props.onLoadEarlier;

    const footer = React.useMemo(() => {
        if (props.loadingEarlier) {
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-loading-earlier`}
                    size="line"
                    kind="loading"
                    title={t('session.transcriptNavigation.loadingEarlierTurns')}
                />
            );
        }
        const loadEarlier = onLoadEarlier && !historyComplete
            ? { label: t('session.transcriptNavigation.loadEarlierTurns'), onPress: onLoadEarlier }
            : undefined;
        if (filter === 'approvals' || filter === 'errors') {
            if (partial) {
                return (
                    <SurfaceStateCard
                        testID={`${testIDPrefix}-partial`}
                        size="line"
                        kind="empty"
                        title={filter === 'approvals'
                            ? t('session.transcriptNavigation.partialApprovals')
                            : t('session.transcriptNavigation.partialErrors')}
                        action={loadEarlier}
                    />
                );
            }
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-filter-end`}
                    size="line"
                    kind="empty"
                    title={filter === 'approvals'
                        ? t('session.transcriptNavigation.filterEndApprovals', { count: summary.counts.approvals, total: summary.counts.all })
                        : t('session.transcriptNavigation.filterEndErrors', { count: summary.counts.errors, total: summary.counts.all })}
                    action={{ label: t('session.transcriptNavigation.showAllTurns'), onPress: showAll }}
                />
            );
        }
        if (filter === 'all' && loadEarlier) {
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-load-earlier`}
                    size="line"
                    kind="empty"
                    title={t('session.transcriptNavigation.earlierTurnsNotListed')}
                    action={loadEarlier}
                />
            );
        }
        return null;
    }, [filter, historyComplete, onLoadEarlier, partial, props.loadingEarlier, showAll, summary.counts, testIDPrefix]);

    const renderBody = () => {
        if (showLoading) {
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-loading`}
                    kind="loading"
                    title={t('session.transcriptNavigation.loadingBody')}
                />
            );
        }
        if (props.entries.length === 0) {
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-empty`}
                    kind="empty"
                    iconName="list-bullets"
                    title={t('session.transcriptNavigation.emptyAllTitle')}
                    reason={t('session.transcriptNavigation.emptyAllBody')}
                />
            );
        }
        if (entries.length > 0) {
            return (
                <TranscriptNavigationEntryList
                    entries={entries}
                    activeEntryId={props.activeEntryId}
                    visibleEntryIds={props.visibleEntryIds}
                    newestTurn={props.newestTurn ?? null}
                    showApprovals={filter === 'approvals'}
                    sessionStart={filter === 'all' && historyComplete ? props.sessionStart ?? null : null}
                    footer={footer}
                    onEntryPress={props.onEntryPress}
                    onRequestClose={props.onRequestClose}
                    testIDPrefix={testIDPrefix}
                />
            );
        }
        if (filter === 'pinned') {
            return (
                <SurfaceStateCard
                    testID={`${testIDPrefix}-empty-pinned`}
                    kind="empty"
                    iconName="push-pin"
                    title={t('session.transcriptNavigation.emptyPinnedTitle')}
                    reason={t('session.transcriptNavigation.emptyPinnedHint')}
                    note={t('session.transcriptNavigation.emptyPinnedPrivacy')}
                    // Quiet, not a filled primary: the way back to every turn, not a task.
                    secondaryAction={{ label: t('session.transcriptNavigation.showAllTurns'), onPress: showAll }}
                />
            );
        }
        // A fact filter with no match: one line, honest about partial history.
        return (
            <View style={styles.lineState}>
                <SurfaceStateCard
                    testID={`${testIDPrefix}-empty-${filter}`}
                    size="line"
                    kind="empty"
                    title={filter === 'approvals'
                        ? (partial ? t('session.transcriptNavigation.noApprovalsSoFar') : t('session.transcriptNavigation.noApprovals'))
                        : (partial ? t('session.transcriptNavigation.noErrorsSoFar') : t('session.transcriptNavigation.noErrors'))}
                    action={{ label: t('session.transcriptNavigation.showAllTurns'), onPress: showAll }}
                />
            </View>
        );
    };

    return (
        <View
            testID={`${testIDPrefix}-panel`}
            style={styles.container}
            accessibilityLabel={t('session.transcriptNavigation.title')}
        >
            {props.entries.length > 0 ? (
                <View style={styles.filters}>
                    <SegmentedTabBar
                        tabs={tabs}
                        activeTabId={filter}
                        onSelectTab={setFilter}
                        testIDPrefix={`${testIDPrefix}-filter`}
                        presentation="pills"
                        segmentSizing="content"
                        accessibilityLabel={t('session.transcriptNavigation.filtersA11y')}
                    />
                </View>
            ) : null}
            {props.offline ? (
                <View style={styles.freshness}>
                    <SurfaceFreshnessLine asOf={props.offline.asOfMs} reason={props.offline.reason} />
                </View>
            ) : null}
            <View style={styles.body}>
                {renderBody()}
            </View>
        </View>
    );
});
