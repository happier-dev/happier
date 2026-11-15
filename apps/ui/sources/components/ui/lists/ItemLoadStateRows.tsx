import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
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

/** A page row's text edge, with no glyph column: the shared loading rows in the section's row box. */
const PAGE_ROW_SKELETON_GEOMETRY = Object.freeze({
    insetStart: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    insetEnd: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    glyphColumn: 0,
    gap: 0,
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
    /** Whether the rows being reserved carry a second line (a description or status). */
    lines?: 1 | 2;
    /** The rows' shape: `list` for a compact list's rows (`ItemGroup density="compact"`). */
    shape?: PageRowShape;
    /** Names what is loading for assistive technology ("Loading machine pools"). */
    accessibilityLabel?: string;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const testID = props.testID;
    // The reserved rows take the real rows' box at the user's density, so nothing moves when they arrive.
    const rowMetrics = usePageRowMetrics(props.shape);
    const divided = React.useContext(ItemLoadStateRowDividersContext);
    const rowBox = React.useMemo(
        () => ({ minHeight: rowMetrics.minHeightPx, paddingVertical: rowMetrics.paddingVerticalPx }),
        [rowMetrics],
    );

    if (props.state.kind === 'failed' && props.state.homeServerIds && props.state.homeServerIds.length > 0) {
        return <HomeScopedFailedRow testID={testID} state={props.state} homeServerIds={props.state.homeServerIds} />;
    }

    if (props.state.kind === 'failed') {
        return <FailedRow testID={testID} state={props.state} />;
    }

    return (
        <SkeletonRows
            {...(testID === undefined ? {} : { testID, rowTestID: (index: number) => `${testID}-skeleton:${index}` })}
            {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
            rows={Math.max(1, Math.floor(props.rows ?? 2))}
            lines={props.lines ?? 2}
            rowBox={rowBox}
            geometry={PAGE_ROW_SKELETON_GEOMETRY}
            {...(divided ? { dividerColor: theme.colors.border.subtle, dividerPlacement: 'between' as const } : {})}
        />
    );
});
