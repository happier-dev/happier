import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import type { AgentActivityRowActionId, AgentActivityRowEntry } from '../agentActivityRowEntry';
import { useAgentActivityStalenessResolver } from '../presentation/useAgentActivityStaleness';
import { AgentActivityDisclosure } from '../row/AgentActivityDisclosure';
import { AgentActivityRow } from '../row/AgentActivityRow';
import {
    AgentActivityEmptyState,
    type AgentActivityEmptyStateVariant,
} from '../states/AgentActivityEmptyState';
import {
    AGENT_ACTIVITY_SKELETON_MAX_ROWS,
    AgentActivitySkeleton,
} from '../states/AgentActivitySkeleton';
import { resolveAgentActivityListMotion } from './agentActivityListMotion';
import {
    AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT,
    buildAgentActivitySectionModel,
    flattenAgentActivitySectionModel,
    type AgentActivityListItem,
} from './agentActivitySectionModel';
import { AgentActivitySectionHeader } from './AgentActivitySectionHeader';
import { useListMotionQuiet, type ListMotionQuiet } from './listMotionQuiet';
import { useAgentActivitySectionMigration } from './useAgentActivitySectionMigration';

/**
 * The one agent-activity list: sections as headings, rows as siblings, one scroll owner (4.7).
 *
 * **It does not scroll.** Its hosts already do — the agents pane, the work-state popover, the
 * transcript card — and a scroller inside a scroller is the bug that makes a roster impossible to
 * flick through on a phone. The list lays out a column; the host decides how it is scrolled and
 * what chrome sits around it.
 *
 * **Everything is a sibling.** Headers, rows and the one "show all" affordance come out of a single
 * flat sequence and are mapped exactly once. Wrapping each section in its own container would look
 * identical and would remount any row that changed section — so a finishing agent could never
 * visibly travel from `working` to `finished`, it could only vanish and reappear.
 *
 * **A finished agent does not jump.** It settles its status mark where it stands, waits out the
 * dwell, and then travels — with every other row that came due in the same window, in one reflow,
 * and never while the list is being scrolled or hovered. The timing lives in
 * `useAgentActivitySectionMigration`, the gate in `listMotionQuiet`, and the springs in
 * `agentActivityListMotion`; this component only joins them to the flat sequence above.
 */

export type AgentActivityListFreshness =
    | Readonly<{ kind: 'live' }>
    /** Roster still arriving. `expectedCount` comes from the activity headline, or is unknown. */
    | Readonly<{ kind: 'hydrating'; expectedCount: number | null }>
    /** Cannot reach the source. Whatever is on screen is the last thing we actually knew. */
    | Readonly<{ kind: 'offline' }>;

const LIVE_FRESHNESS: AgentActivityListFreshness = { kind: 'live' };

export type AgentActivityListProps = Readonly<{
    /**
     * Must be referentially stable for unchanged work (INV-4): the rows are memoized on the entry
     * object, so a producer that rebuilds entries every tick re-renders the whole roster every tick.
     */
    entries: readonly AgentActivityRowEntry[];
    /**
     * One callback for the list, keyed by entry id — never one closure per row.
     *
     * Offered to a row only when that row's `entry.canOpen === true`. Fail-closed, because the
     * failure it prevents is silent: a row that presses to nothing still ripples, still highlights
     * and is still announced as a button (A9).
     */
    onPress?: (entryId: string) => void;
    onAction?: (entryId: string, actionId: AgentActivityRowActionId) => void;
    /**
     * The expandable body for an entry, or `null` for the rows that open somewhere else.
     *
     * The row owns anatomy; the host owns disclosure (§4.3.1). Some units of work have nowhere to
     * navigate to — a background command is a headless process with no transcript and no route — so
     * their detail is disclosed in place, through the same `AgentActivityDisclosure` the transcript
     * card uses, rather than by inventing a screen for them. A row whose host returns `null` keeps
     * `onPress` and behaves exactly as before, so this cannot quietly change existing rows.
     */
    renderEntryBody?: (entryId: string) => React.ReactNode;
    /**
     * Where "show all finished" goes. Its presence is what enables the in-pane cap: without a route
     * the cap would hide rows the reader has no way to reach, so the list shows all of them instead.
     */
    onShowAllFinished?: () => void;
    /**
     * Lifts the WORKING cap, in place. Same rule as the finished cap: `workingLimit` only applies
     * when a host supplied somewhere for the affordance to go.
     */
    onShowAllWorking?: () => void;
    /** Bound on the WORKING section for a surface with a height budget. Omitted means no cap. */
    workingLimit?: number | null;
    /**
     * Whether section headings are drawn. A surface whose sections are a subset of one — the
     * compact live-only view — names that section itself in its own chrome, and a second heading
     * under it would state the same thing twice.
     */
    showSectionHeaders?: boolean;
    /** Offered in the first-run empty state. Absent means this host cannot launch anything. */
    onLaunch?: () => void;
    /**
     * Live units this host draws itself, outside the list — the members of a running workflow it
     * renders as a run panel.
     *
     * The WORKING heading states how much work the section covers, not how many rows it printed,
     * so the pane's heading and the tab badge above it (both fed by the one count owner) can never
     * be two different numbers about the same session. See `buildAgentActivitySectionModel`.
     */
    foldedWorkingCount?: number;
    /** Which empty state applies. Only the host knows whether this session ever had an agent. */
    emptyVariant?: AgentActivityEmptyStateVariant;
    freshness?: AgentActivityListFreshness;
    metaPlacement?: 'below' | 'inline';
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    /**
     * Horizontal correction applied to ROWS only, so a host that already pads its content can
     * cancel `Item`'s own padding.
     *
     * Per row rather than to the whole body, for the same reason the workflow card does it that
     * way: section headings sit on the host's content edge and bleeding the container would drag
     * them out of alignment with the rows instead of fixing the rows.
     */
    rowInsetCorrectionPx?: number;
    /**
     * Threaded to every row's spinner so an inactive tab or an off-screen pane stops animating,
     * and the master switch for the list's own motion: with it off, rows take their real section
     * at once rather than dwelling for a travel nobody would see.
     */
    animationEnabled?: boolean;
    /**
     * The quiet window of the scroller that owns this list, so a migration never lands mid-scroll.
     *
     * Optional because the list does not scroll itself: a host with a scroller creates one with
     * `useListMotionQuiet()` and spreads its `scrollProps`; a host without one leaves this unset
     * and the list still honours the pointer half of the gate on its own.
     */
    motionQuiet?: ListMotionQuiet;
    testID?: string;
}>;

export const AgentActivityList = React.memo((props: AgentActivityListProps) => {
    const {
        animationEnabled: animationEnabledProp,
        density,
        emptyVariant = 'firstUse',
        entries,
        foldedWorkingCount,
        metaPlacement,
        onAction,
        onLaunch,
        onPress,
        onShowAllFinished,
        onShowAllWorking,
        renderEntryBody,
        testID,
    } = props;
    const freshness = props.freshness ?? LIVE_FRESHNESS;
    const showSectionHeaders = props.showSectionHeaders !== false;
    const workingLimit = props.workingLimit ?? null;

    const reducedMotion = useReducedMotionPreference();
    const animationEnabled = animationEnabledProp !== false;
    const ownQuiet = useListMotionQuiet();
    const quiet = props.motionQuiet ?? ownQuiet.quiet;
    const motion = resolveAgentActivityListMotion({ animationEnabled, reducedMotion });
    const placementById = useAgentActivitySectionMigration({
        entries,
        quiet,
        enabled: animationEnabled,
    });

    const items = React.useMemo(() => {
        const flattened = flattenAgentActivitySectionModel(
            buildAgentActivitySectionModel({
                entries,
                finishedLimit: onShowAllFinished ? AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT : null,
                workingLimit: onShowAllWorking ? workingLimit : null,
                placementById,
                ...(typeof foldedWorkingCount === 'number' ? { foldedWorkingCount } : null),
            }),
        );
        // Dropped from the sequence rather than rendered as nothing: an empty motion wrapper would
        // still take part in the layout animation and still claim an entrance.
        return showSectionHeaders ? flattened : flattened.filter((item) => item.kind !== 'header');
    }, [
        entries,
        foldedWorkingCount,
        onShowAllFinished,
        onShowAllWorking,
        placementById,
        showSectionHeaders,
        workingLimit,
    ]);

    // Which keys were on screen last commit. An entrance belongs to a row that has genuinely just
    // arrived, never to the roster a pane opens with and never to a row coming back — a re-entering
    // row is not a new row.
    const renderedKeysRef = React.useRef<ReadonlySet<string> | null>(null);
    const previouslyRenderedKeys = renderedKeysRef.current;
    React.useEffect(() => {
        renderedKeysRef.current = new Set(items.map((item) => item.key));
    }, [items]);

    const holdMotion = React.useCallback(() => quiet.setPointerInside(true), [quiet]);
    const releaseMotion = React.useCallback(() => quiet.setPointerInside(false), [quiet]);
    // A host-owned quiet window outlives this list, so a list unmounting under the cursor must not
    // leave it permanently holding.
    React.useEffect(() => () => quiet.setPointerInside(false), [quiet]);

    // The one clock behind the 90 s / 10 min notes, held here rather than in the row so a roster
    // tick re-renders the rows whose note actually changed and nothing else.
    const resolveStaleness = useAgentActivityStalenessResolver();

    const hasEntries = entries.length > 0;
    /**
     * Emptiness is about the SURFACE, not about this list's array.
     *
     * A host that draws a running workflow as its own panel hands the list zero entries and states
     * the folded work in `foldedWorkingCount` — and the list answered "no agents yet" underneath a
     * panel that was visibly running one, which is the defect a user photographed. Anything drawn
     * outside the list is still work on screen, so it disqualifies the empty state.
     */
    const hasFoldedWork = (foldedWorkingCount ?? 0) > 0;
    const skeletonRows = resolveSkeletonRowCount({ hasEntries: hasEntries || hasFoldedWork, freshness });
    const notice = resolveFreshnessNotice({ freshness, skeletonRows });

    const renderItemContent = (item: AgentActivityListItem): React.ReactNode => {
        if (item.kind === 'header') {
            return (
                <AgentActivitySectionHeader
                    sectionId={item.sectionId}
                    count={item.count}
                    density={density}
                    testID={testID ? `${testID}:section:${item.sectionId}` : undefined}
                />
            );
        }
        if (item.kind === 'showAll') {
            const isFinished = item.sectionId === 'finished';
            return (
                <Item
                    testID={testID ? `${testID}:show-all:${item.sectionId}` : undefined}
                    title={isFinished
                        ? t('session.agentActivity.list.showAllFinished', { count: item.totalCount })
                        : t('tools.workflowActivityView.showMore', { count: item.hiddenCount })}
                    onPress={isFinished ? onShowAllFinished : onShowAllWorking}
                    showDivider={false}
                    density={density}
                />
            );
        }
        const body = renderEntryBody?.(item.entry.id) ?? null;
        if (body != null) {
            return (
                <AgentActivityDisclosure
                    entry={item.entry}
                    body={body}
                    // The SAME fail-closed rule as the plain row below, applied to the same
                    // question: a disclosed row is not a second kind of row, and a body appearing
                    // under it must not change what its press means or which actions it offers.
                    onPress={item.entry.canOpen === true ? onPress : undefined}
                    onAction={onAction}
                    metaPlacement={metaPlacement}
                    density={density}
                    staleness={resolveStaleness(item.entry)}
                    animationEnabled={animationEnabledProp}
                    showDivider={!item.isLastInSection}
                    testID={testID ? `${testID}:row:${item.entry.id}` : undefined}
                />
            );
        }
        return (
            <AgentActivityRow
                entry={item.entry}
                // Fail-closed: the press is offered only where a target was RESOLVED, never because
                // the kind suggests one. See `AgentActivityRowEntry.canOpen`.
                onPress={item.entry.canOpen === true ? onPress : undefined}
                onAction={onAction}
                metaPlacement={metaPlacement}
                density={density}
                animationEnabled={animationEnabledProp}
                staleness={resolveStaleness(item.entry)}
                // The hairline stops at the section edge, so the headings read as breaks rather
                // than as rows that happen to have bold text.
                showDivider={!item.isLastInSection}
                testID={testID ? `${testID}:row:${item.entry.id}` : undefined}
            />
        );
    };

    /**
     * Every item is wrapped so the whole sequence can re-lay-out together. `layout` on one row and
     * not its neighbours would tear: the travelling row would glide while everything making space
     * for it snapped.
     */
    const rowInsetCorrectionPx = props.rowInsetCorrectionPx ?? 0;
    const rowInsetStyle = React.useMemo(
        () => (rowInsetCorrectionPx === 0 ? undefined : { marginHorizontal: rowInsetCorrectionPx }),
        [rowInsetCorrectionPx],
    );

    const renderItem = (item: AgentActivityListItem): React.ReactNode => (
        <Animated.View
            key={item.key}
            testID={testID ? `${testID}:motion:${item.key}` : undefined}
            style={item.kind === 'row' ? rowInsetStyle : undefined}
            layout={motion.layout}
            entering={
                previouslyRenderedKeys != null && !previouslyRenderedKeys.has(item.key)
                    ? motion.entering
                    : undefined
            }
        >
            {renderItemContent(item)}
        </Animated.View>
    );

    return (
        <View
            testID={testID}
            style={styles.container}
            onPointerEnter={holdMotion}
            onPointerLeave={releaseMotion}
            onPointerCancel={releaseMotion}
        >
            {notice != null ? (
                <Text
                    testID={testID ? `${testID}:notice` : undefined}
                    style={styles.notice}
                >
                    {notice}
                </Text>
            ) : null}
            {skeletonRows > 0 ? (
                <AgentActivitySkeleton
                    count={skeletonRows}
                    testID={testID ? `${testID}:skeleton` : undefined}
                />
            ) : null}
            {hasEntries ? (
                <View testID={testID ? `${testID}:body` : undefined} style={styles.body}>
                    {items.map(renderItem)}
                </View>
            ) : null}
            {!hasEntries && !hasFoldedWork && freshness.kind === 'live' ? (
                <AgentActivityEmptyState
                    variant={emptyVariant}
                    onLaunch={onLaunch}
                    testID={testID ? `${testID}:empty` : undefined}
                />
            ) : null}
        </View>
    );
});

AgentActivityList.displayName = 'AgentActivityList';

/**
 * How many placeholder rows to draw, which is zero unless the headline said how many to expect.
 *
 * Two rules, both about not lying: a skeleton never covers content that is already on screen (that
 * is the "flash to empty" this pane must not do), and a count is never invented.
 */
function resolveSkeletonRowCount(params: Readonly<{
    hasEntries: boolean;
    freshness: AgentActivityListFreshness;
}>): number {
    if (params.hasEntries || params.freshness.kind !== 'hydrating') return 0;
    const expected = params.freshness.expectedCount;
    if (expected == null || expected <= 0) return 0;
    return Math.min(Math.floor(expected), AGENT_ACTIVITY_SKELETON_MAX_ROWS);
}

/**
 * The honest one-liner about where this data came from, or `null` when it is simply live.
 *
 * Suppressed while a skeleton is drawing, because the skeleton already says "still arriving" and
 * two simultaneous statements of the same fact read as two facts.
 */
function resolveFreshnessNotice(params: Readonly<{
    freshness: AgentActivityListFreshness;
    skeletonRows: number;
}>): string | null {
    if (params.freshness.kind === 'offline') return t('session.agentActivity.list.offline');
    if (params.freshness.kind === 'hydrating' && params.skeletonRows === 0) {
        return t('session.agentActivity.list.refreshing');
    }
    return null;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
    },
    body: {
        width: '100%',
    },
    notice: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
}));
