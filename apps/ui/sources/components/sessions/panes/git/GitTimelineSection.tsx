import * as React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition, ReduceMotion, ZoomIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ScmLogEntry } from '@happier-dev/protocol';

import { SourceControlOperationsHistoryTimelineRow } from '@/components/workspaces/scm/SourceControlOperationsHistoryTimelineRow';
import { SourceControlOperationsHistoryLoadMoreButton } from '@/components/workspaces/scm/SourceControlOperationsHistoryLoadMoreButton';
import { ScmTimelineGutter } from '@/components/workspaces/scm/history/ScmTimelineGutter';
import { Icon } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { projectGitTimeline, type GitTimelineCommit } from '@/scm/history/gitTimelineProjection';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { GitCommitFlightAnchorsContext } from './gitCommitFlightAnchors';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

export type GitTimelineSectionProps = Readonly<{
    testID?: string;
    /** The working tree's facts (the Now node and where origin sits). */
    changedCount: number;
    selectedCount: number;
    ahead: number;
    behind: number;
    upstream: string | null;
    /** The current branch's history, newest first, from the one paged history owner. */
    entries: readonly ScmLogEntry[];
    /** What origin has that this branch does not; `null` while unknown. */
    incoming: readonly ScmLogEntry[] | null;
    loading: boolean;
    hasMore: boolean;
    onLoadMore: () => void;
    onOpenCommit: (sha: string) => void;
    /** The commit that just landed from this pane (it wears "just now" and lands blue). */
    landedSha: string | null;
    onCommitLayout?: (sha: string, y: number, height: number) => void;
}>;

/**
 * The branch as a timeline (Git lab A/HI/S/SX): what is not committed yet (Now), then commits newest first
 * with their time on the left — hollow while they are only on this machine, filled once origin has them, dashed
 * while they are on origin but not here — and origin's marker exactly where origin is. Pure presentation over
 * `projectGitTimeline`; the pane owns the reads.
 */
export const GitTimelineSection = React.memo(function GitTimelineSection(props: GitTimelineSectionProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const timeline = React.useMemo(() => projectGitTimeline({
        now: Date.now(),
        changedCount: props.changedCount,
        ahead: props.ahead,
        behind: props.behind,
        upstream: props.upstream,
        current: props.entries as ScmLogEntry[],
        incoming: props.incoming as ScmLogEntry[] | null,
    }), [props.ahead, props.behind, props.changedCount, props.entries, props.incoming, props.upstream]);

    const commits = React.useMemo(() => timeline.groups.flatMap((group, groupIndex) => group.commits.map((commit, index) => ({
        commit,
        groupLabel: index === 0 && !(groupIndex === 0 && group.label === 'earlier-today') ? group.label : null,
    }))), [timeline.groups]);
    const entryBySha = React.useMemo(() => {
        const bySha = new Map<string, ScmLogEntry>();
        for (const entry of props.incoming ?? []) bySha.set(entry.sha, entry);
        for (const entry of props.entries) bySha.set(entry.sha, entry);
        return bySha;
    }, [props.entries, props.incoming]);

    // Git lab SX: nodes that just changed state fill one after another — bottom-up after a push (local → shared),
    // top-down after a pull (incoming → here). The previous relation of each commit is remembered across renders.
    const previousRelationRef = React.useRef<Map<string, GitTimelineCommit['relation']> | null>(null);
    const fillDelays = React.useMemo(
        () => resolveTimelineFillDelays(previousRelationRef.current, commits.map(({ commit }) => commit)),
        [commits],
    );
    React.useEffect(() => {
        previousRelationRef.current = new Map(commits.map(({ commit }) => [commit.sha, commit.relation]));
    }, [commits]);
    const flightAnchors = React.useContext(GitCommitFlightAnchorsContext);
    const registerNewest = React.useCallback((view: View | null) => {
        if (flightAnchors) flightAnchors.newestCommit.current = view;
    }, [flightAnchors]);
    const landedRingDelayMs = reducedMotionForRing(motionTokens.successMoment);

    const origin = timeline.origin;
    // Git lab SX "Push": origin rides up the rail to where it now is (one layout glide; none under reduced motion).
    const reducedMotion = useReducedMotionPreference();
    const originGlide = React.useMemo(() => (reducedMotion ? undefined : LinearTransition
        .duration(240)
        .easing(reanimatedMotionTokens.layoutEasing.standard)
        .reduceMotion(ReduceMotion.Never)), [reducedMotion]);
    const originChip = origin ? (
        <Animated.View key="origin" layout={originGlide}>
            <OriginMarker name={origin.name} upToDate={props.ahead === 0 && props.behind === 0} />
        </Animated.View>
    ) : null;
    const hasNow = props.changedCount > 0;
    const firstCommitSha = commits[0]?.commit.sha ?? null;

    if (!hasNow && commits.length === 0) {
        if (props.loading) {
            return <SurfaceStateCard testID="session-git-timeline-loading" size="line" kind="loading" title={t('sessionGitPane.flow.timeline.loading')} />;
        }
        return null;
    }

    const rows: React.ReactNode[] = [];
    if (origin?.kind === 'at-head' || (origin?.kind === 'incoming' && origin.sha === firstCommitSha)) rows.push(originChip);
    commits.forEach(({ commit, groupLabel }, index) => {
        if (groupLabel) {
            rows.push(<Text key={`group-${commit.sha}`} style={styles.groupLabel}>{groupLabelText(groupLabel)}</Text>);
        }
        if (origin?.kind === 'incoming' && origin.sha === commit.sha && index > 0) rows.push(originChip);
        const entry = entryBySha.get(commit.sha);
        if (entry) {
            const row = (
                <SourceControlOperationsHistoryTimelineRow
                    key={commit.sha}
                    fillDelayMs={fillDelays.get(commit.sha)}
                    ringDelayMs={commit.sha === props.landedSha ? landedRingDelayMs : undefined}
                    theme={theme}
                    entry={entry}
                    isHead={false}
                    relation={commit.relation}
                    whenFormat="time"
                    tag={commit.sha === props.landedSha ? 'just-now' : commit.relation === 'incoming' ? 'to-pull' : null}
                    showTrailingLine={index < commits.length - 1 || props.hasMore}
                    dashedTrailingLine={commit.relation === 'incoming' && commits[index + 1]?.commit.relation === 'incoming'}
                    onOpenCommit={props.onOpenCommit}
                    onCommitLayout={index === 0 && commit.relation !== 'incoming' ? undefined : props.onCommitLayout}
                />
            );
            // The newest commit is where a commit made here lands (the commit chip's target).
            rows.push(index === 0 && commit.relation !== 'incoming'
                ? <View key={commit.sha} ref={registerNewest} collapsable={false} onLayout={props.onCommitLayout ? (event) => {
                    const { y, height } = event.nativeEvent.layout;
                    props.onCommitLayout?.(commit.sha, y, height);
                } : undefined}>{row}</View>
                : row);
        }
        if (origin?.kind === 'after' && origin.sha === commit.sha) rows.push(originChip);
    });
    if (origin?.kind === 'beyond-loaded') {
        rows.push(<Text key="origin-beyond" style={styles.beyond}>{t('sessionGitPane.flow.timeline.originFurther', { name: origin.name })}</Text>);
    }

    return (
        <View testID={props.testID ?? 'session-git-timeline'} style={styles.section}>
            <Text accessibilityRole="header" style={styles.title}>{t('sessionGitPane.flow.timeline.title')}</Text>
            {hasNow ? (
                <View testID="session-git-timeline-now" style={styles.nowRow}>
                    <ScmTimelineGutter when={t('sessionGitPane.flow.timeline.now')} pointTopPx={4} tone="now" showTrailingLine={commits.length > 0} />
                    <View style={styles.nowBody}>
                        <Text style={styles.nowTitle}>
                            {t('sessionGitPane.flow.timeline.uncommitted', { count: props.changedCount, formatted: formatExactCount(props.changedCount) })}
                        </Text>
                        <Text style={styles.nowDetail}>
                            {props.selectedCount > 0
                                ? t('sessionGitPane.flow.timeline.selected', { count: props.selectedCount, formatted: formatExactCount(props.selectedCount) })
                                : t('sessionGitPane.flow.timeline.nothingSelected')}
                        </Text>
                    </View>
                </View>
            ) : null}
            {rows}
            {props.hasMore ? (
                <SourceControlOperationsHistoryLoadMoreButton
                    theme={theme}
                    historyLoading={props.loading}
                    onPress={props.onLoadMore}
                />
            ) : null}
        </View>
    );
});

/**
 * Which nodes just changed state and when each one fills (Git lab SX): after a push the formerly local commits fill
 * bottom-up `fillStaggerMs` apart; after a pull the formerly incoming ones solidify top-down `solidifyStaggerMs` apart.
 * `commits` is newest first; nothing animates on first sight.
 */
export function resolveTimelineFillDelays(
    previous: ReadonlyMap<string, GitTimelineCommit['relation']> | null,
    commits: readonly Pick<GitTimelineCommit, 'sha' | 'relation'>[],
): ReadonlyMap<string, number> {
    const delays = new Map<string, number>();
    if (!previous) return delays;
    const moment = motionTokens.successMoment;
    const pushed = commits.filter((commit) => previous.get(commit.sha) === 'local' && commit.relation === 'shared');
    [...pushed].reverse().forEach((commit, order) => delays.set(commit.sha, order * moment.fillStaggerMs));
    const pulled = commits.filter((commit) => previous.get(commit.sha) === 'incoming' && commit.relation !== 'incoming');
    pulled.forEach((commit, order) => delays.set(commit.sha, order * moment.solidifyStaggerMs));
    return delays;
}

/** The landed node rings as the travelling chip arrives (the gutter drops the ring under reduced motion). */
function reducedMotionForRing(moment: typeof motionTokens.successMoment): number {
    return moment.gatherMs + moment.travelMs;
}

function groupLabelText(label: 'earlier-today' | 'yesterday' | 'older'): string {
    if (label === 'earlier-today') return t('sessionGitPane.flow.timeline.earlierToday');
    if (label === 'yesterday') return t('sessionGitPane.flow.timeline.yesterday');
    return t('sessionGitPane.flow.timeline.older');
}

/** Where origin is: a small cloud chip on the rail with a hairline running to the edge. */
const OriginMarker = React.memo(function OriginMarker(props: Readonly<{ name: string; upToDate: boolean }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const styles = stylesheet;
    const tint = props.upToDate ? theme.colors.state.success.foreground : theme.colors.text.secondary;
    return (
        <View testID="session-git-timeline-origin" style={styles.originRow} accessibilityLabel={t('sessionGitPane.flow.timeline.originA11y', { name: props.name })}>
            <ScmTimelineGutter when="" pointTopPx={0} tone="shared" showLeadingLine showTrailingLine hidePoint />
            <View style={[styles.originChip, { borderColor: tint }]}>
                <Icon name="cloud" size={12} color={tint} />
                <Text style={[styles.originText, { color: tint }]} numberOfLines={1}>{props.name}</Text>
                {props.upToDate ? (
                    <Animated.View entering={reducedMotion ? FadeIn.duration(motionTokens.successMoment.reducedCrossFadeMs) : ZoomIn.duration(motionTokens.successMoment.checkMs)}>
                        <Icon name="check" size={11} color={tint} />
                    </Animated.View>
                ) : null}
            </View>
            <View style={styles.originRule} />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingHorizontal: 12,
        paddingTop: 14,
        paddingBottom: 8,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginBottom: 8,
    },
    groupLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginTop: 10,
        marginBottom: 2,
    },
    nowRow: {
        flexDirection: 'row',
        minHeight: 46,
    },
    nowBody: {
        flex: 1,
        paddingBottom: 12,
    },
    nowTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    nowDetail: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginTop: 2,
    },
    originRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 30,
    },
    originChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        height: 22,
        borderRadius: 11,
        borderWidth: StyleSheet.hairlineWidth * 2,
        backgroundColor: theme.colors.surface.base,
    },
    originText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
    },
    originRule: {
        flex: 1,
        marginLeft: 8,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderStyle: 'dashed',
        borderColor: theme.colors.border.default,
    },
    beyond: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginTop: 6,
        marginLeft: 74,
    },
}));

export type { GitTimelineCommit };
