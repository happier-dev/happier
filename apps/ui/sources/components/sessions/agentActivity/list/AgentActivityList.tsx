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
    /** One callback for the list, keyed by entry id — never one closure per row. */
    onPress?: (entryId: string) => void;
    onAction?: (entryId: string, actionId: AgentActivityRowActionId) => void;
    /**
     * Where "show all finished" goes. Its presence is what enables the in-pane cap: without a route
     * the cap would hide rows the reader has no way to reach, so the list shows all of them instead.
     */
    onShowAllFinished?: () => void;
    /** Offered in the first-run empty state. Absent means this host cannot launch anything. */
    onLaunch?: () => void;
    /** Which empty state applies. Only the host knows whether this session ever had an agent. */
    emptyVariant?: AgentActivityEmptyStateVariant;
    freshness?: AgentActivityListFreshness;
    metaPlacement?: 'below' | 'inline';
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
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
        metaPlacement,
        onAction,
        onLaunch,
        onPress,
        onShowAllFinished,
        testID,
    } = props;
    const freshness = props.freshness ?? LIVE_FRESHNESS;

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

    const items = React.useMemo(() => flattenAgentActivitySectionModel(
        buildAgentActivitySectionModel({
            entries,
            finishedLimit: onShowAllFinished ? AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT : null,
            placementById,
        }),
    ), [entries, onShowAllFinished, placementById]);

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
    const skeletonRows = resolveSkeletonRowCount({ hasEntries, freshness });
    const notice = resolveFreshnessNotice({ freshness, skeletonRows });

    const renderItemContent = (item: AgentActivityListItem): React.ReactNode => {
        if (item.kind === 'header') {
            return (
                <AgentActivitySectionHeader
                    sectionId={item.sectionId}
                    count={item.count}
                    testID={testID ? `${testID}:section:${item.sectionId}` : undefined}
                />
            );
        }
        if (item.kind === 'showAll') {
            return (
                <Item
                    testID={testID ? `${testID}:show-all:finished` : undefined}
                    title={t('session.agentActivity.list.showAllFinished', { count: item.totalCount })}
                    onPress={onShowAllFinished}
                    showDivider={false}
                    density={density}
                />
            );
        }
        return (
            <AgentActivityRow
                entry={item.entry}
                onPress={onPress}
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
    const renderItem = (item: AgentActivityListItem): React.ReactNode => (
        <Animated.View
            key={item.key}
            testID={testID ? `${testID}:motion:${item.key}` : undefined}
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
            {!hasEntries && freshness.kind === 'live' ? (
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
