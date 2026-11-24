import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useSectionRowBleedStyle } from '@/components/ui/lists/bareRowBleed';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { CollectionSkeletonRows } from '@/components/ui/lists/collection/CollectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { happierPageRowDividerWidth, resolveHappierItemBehavior } from '@happier-dev/plugin-ui/presentation';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useSectionLeadingColumn } from '@/components/ui/lists/sectionLeadingColumn';
import type { PageRowShape } from '@/components/ui/lists/pageRowMetrics';
import { t } from '@/text';
import { useFailureExplainedByUnreachableHome } from '@/components/navigation/connectionStatus/HomeReachabilityGate';

/**
 * What a section's rows are waiting for. It comes from the data owner, never from a timer here:
 * `failed` is what the owner reports when the read failed or the Home/machine did not answer.
 */
export type ItemLoadState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{
        kind: 'failed';
        /** Already-translated: what could not be read, and where ("Couldn't read machine pools on Studio"). */
        reason: string;
        /** Present when asking again can help; absent for failures the viewer cannot fix from here. */
        onRetry?: () => void | Promise<unknown>;
        /**
         * The Homes this read needed. When they are all the Home this device uses and it is
         * unreachable, the page's "can't reach" banner already says so: the rows then wait quietly,
         * with no second Retry, and read again by themselves once the Home answers.
         */
        homeServerIds?: readonly string[];
    }>;

type FailedLoadState = Extract<ItemLoadState, { kind: 'failed' }>;

/**
 * What failed, with Retry when asking again can help: the one shared inline notice (OWNER-UI-1115B A2), so a section's
 * failed read looks like every other small failure in the app rather than a row of its own with a button.
 */
const FailedRow = React.memo(function FailedRow(props: Readonly<{ state: FailedLoadState; testID?: string }>) {
    const { reason, onRetry } = props.state;
    return (
        <SurfaceStateCard
            testID={props.testID}
            size="line"
            kind="error"
            title={reason}
            // A read that failed after the rows were shown is announced, as the state cards' alerts are.
            accessibilitySemantics="alert"
            {...(onRetry ? { action: {
                label: t('common.retry'),
                onPress: () => Promise.resolve(onRetry()),
                ...(props.testID ? { testID: `${props.testID}-retry` } : {}),
            } } : {})}
        />
    );
});

/**
 * A failed read from specific Homes. Mounted only for such a failure, so the connection-health
 * subscription never runs behind loaded rows.
 */
const HomeScopedFailedRow = React.memo(function HomeScopedFailedRow(props: Readonly<{
    state: FailedLoadState;
    homeServerIds: readonly string[];
    testID?: string;
}>) {
    const deferred = useFailureExplainedByUnreachableHome(props.homeServerIds);
    const wasDeferred = React.useRef(deferred);
    const { onRetry } = props.state;
    React.useEffect(() => {
        // The Home answers again (after the banner's Retry, or by itself): read again.
        if (wasDeferred.current && !deferred) void onRetry?.();
        wasDeferred.current = deferred;
    }, [deferred, onRetry]);

    if (!deferred) return <FailedRow testID={props.testID} state={props.state} />;
    // The page's "can't reach" banner already says why: the section waits quietly in the same inline notice.
    return (
        <SurfaceStateCard
            testID={props.testID}
            size="line"
            kind="unavailable"
            title={t('sidebarFooter.availableWhenHomeAnswers')}
        />
    );
});

/**
 * Whether reserved rows draw the hairlines between them. A container that draws every divider itself
 * (a widget group's cells) turns them off, so a loading cell never reads as more cells.
 */
export const ItemLoadStateRowDividersContext = React.createContext(true);

/**
 * A page row's text edge, with no glyph: the shared loading rows in the section's row box. In a section whose rows
 * reserve the leading column (an icon or mark in any row), the bars start where the titles do.
 */
const PAGE_ROW_SKELETON_GEOMETRY = Object.freeze({
    insetStart: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    insetEnd: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    glyphColumn: 0,
    gap: 0,
});
const PAGE_ROW_SKELETON_GEOMETRY_PAST_LEADING_COLUMN = Object.freeze({
    ...PAGE_ROW_SKELETON_GEOMETRY,
    insetStart: PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
});

/**
 * The one loading state of a section's rows: while the owner reads, the rows' space is reserved by
 * quiet placeholders in the rows' final shape (never a "Loading…" text row); when the owner reports a
 * failure, the placeholders give way to one row that says what failed and offers Retry.
 *
 * Render it inside the section's `ItemGroup` in place of its rows. Placeholders use the sheet's own
 * hairline tone, so the page's content, not its placeholder, is the loudest thing on it.
 */
export const ItemLoadStateRows = React.memo(function ItemLoadStateRows(props: Readonly<{
    state: ItemLoadState;
    /** How many rows to reserve: the expected (or last known) count, at most a screenful. */
    rows?: number;
    /** Whether the rows being reserved carry a second line (a description or status). Defaults to two. */
    lines?: 1 | 2;
    /** The arriving rows include a leading mark, even if no marked sibling is mounted yet. */
    hasLeadingMark?: boolean;
    /** The rows' shape: `list` for a compact list's rows (`ItemGroup density="compact"`). */
    shape?: PageRowShape;
    /**
     * `catalogRow`: the arriving rows are catalog records (a Team, a person in a rail): the reserve takes the catalog
     * row's own pitch, leading column and rule (`CollectionSkeletonRows`), in a column or on a page, instead of a
     * settings row's.
     */
    rowRole?: 'catalogRow';
    /** Names what is loading for assistive technology ("Loading machine pools"). */
    accessibilityLabel?: string;
    /**
     * Whether the reserved block's last two-line row keeps its hairline. The section's last row omits it.
     */
    showDivider?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const testID = props.testID;
    // The reserved rows take the real rows' box at the user's density, so nothing moves when they arrive.
    const rowMetrics = usePageRowMetrics(props.shape);
    const sectionDividers = React.useContext(ItemLoadStateRowDividersContext);
    const rowPosition = useItemGroupRowPosition();
    const bleedStyle = useSectionRowBleedStyle();
    const hasLeadingMark = props.state.kind === 'loading' && props.hasLeadingMark === true;
    const reservesLeadingColumn = useSectionLeadingColumn(hasLeadingMark) || hasLeadingMark;
    const rowBox = React.useMemo(
        () => ({ minHeight: rowMetrics.minHeightPx, paddingVertical: rowMetrics.paddingVerticalPx }),
        [rowMetrics],
    );
    const lines = props.lines ?? 2;
    const divided = resolveHappierItemBehavior({
        role: 'button',
        hasPrimaryAction: false,
        showDivider: sectionDividers,
        multiline: lines === 2,
    }).dividerVisible;
    // A page row's hairline stands in its flow, under the row: each reserved row keeps that room, and the last one
    // keeps it, with its hairline, when the arriving last row will draw one.
    const trailingDivider = divided && props.showDivider !== false && rowPosition?.isLast !== true;
    const ruleRoom = React.useMemo(() => {
        const hairline = happierPageRowDividerWidth();
        return divided ? { rowGap: hairline, paddingBottom: trailingDivider ? hairline : 0 } : undefined;
    }, [divided, trailingDivider]);
    // Each bar stands in the line box of the text it holds, so a reserved line is exactly as tall as the row that
    // arrives: its title line and, for a two-line row, the gap and its description line, as `Item` draws them.
    const lineHeights = React.useMemo(
        () => lines === 2
            ? [rowMetrics.title.lineHeight, rowMetrics.subtitle.marginTop + rowMetrics.subtitle.lineHeight] as const
            : [rowMetrics.title.lineHeight] as const,
        [lines, rowMetrics],
    );

    if (props.state.kind === 'failed' && props.state.homeServerIds && props.state.homeServerIds.length > 0) {
        return <HomeScopedFailedRow testID={testID} state={props.state} homeServerIds={props.state.homeServerIds} />;
    }

    if (props.state.kind === 'failed') {
        return <FailedRow testID={testID} state={props.state} />;
    }

    if (props.rowRole === 'catalogRow') {
        return (
            <CollectionSkeletonRows
                count={Math.max(1, Math.floor(props.rows ?? 2))}
                rowRole="catalogRow"
                hasLeadingMark={hasLeadingMark}
                {...(testID === undefined ? {} : { testID })}
                {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
            />
        );
    }

    const skeleton = (
        <SkeletonRows
            {...(testID === undefined ? {} : { testID, rowTestID: (index: number) => `${testID}-skeleton:${index}` })}
            {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
            rows={Math.max(1, Math.floor(props.rows ?? 2))}
            lineHeights={lineHeights}
            rowBox={rowBox}
            geometry={reservesLeadingColumn ? PAGE_ROW_SKELETON_GEOMETRY_PAST_LEADING_COLUMN : PAGE_ROW_SKELETON_GEOMETRY}
            {...(divided ? { dividerColor: theme.colors.border.subtle, dividerPlacement: trailingDivider ? 'below' as const : 'between' as const } : {})}
            {...(ruleRoom ? { style: ruleRoom } : {})}
        />
    );
    // The reserved rows stand where the rows will: in a bare contained section they reach past the column as rows do.
    return bleedStyle ? <View style={bleedStyle}>{skeleton}</View> : skeleton;
});
