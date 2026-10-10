import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View, type DimensionValue } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
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

/** One row that says what failed, with Retry when asking again can help. */
const FailedRow = React.memo(function FailedRow(props: Readonly<{ state: FailedLoadState; testID?: string }>) {
    const styles = stylesheet;
    const { reason, onRetry } = props.state;
    return (
        <Item
            testID={props.testID}
            title={reason}
            titleStyle={styles.failedTitle}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={onRetry ? (
                <RoundButton
                    testID={props.testID ? `${props.testID}-retry` : undefined}
                    size="small"
                    display="secondary"
                    title={t('common.retry')}
                    accessibilityLabel={t('common.retry')}
                    action={() => Promise.resolve(onRetry())}
                />
            ) : undefined}
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
    const styles = stylesheet;
    const deferred = useFailureExplainedByUnreachableHome(props.homeServerIds);
    const wasDeferred = React.useRef(deferred);
    const { onRetry } = props.state;
    React.useEffect(() => {
        // The Home answers again (after the banner's Retry, or by itself): read again.
        if (wasDeferred.current && !deferred) void onRetry?.();
        wasDeferred.current = deferred;
    }, [deferred, onRetry]);

    if (!deferred) return <FailedRow testID={props.testID} state={props.state} />;
    return (
        <Item
            testID={props.testID}
            title={t('sidebarFooter.availableWhenHomeAnswers')}
            titleStyle={styles.failedTitle}
            mode="info"
            showChevron={false}
        />
    );
});

/**
 * Whether reserved rows draw the hairlines between them. A container that draws every divider itself
 * (a widget group's cells) turns them off, so a loading cell never reads as more cells.
 */
export const ItemLoadStateRowDividersContext = React.createContext(true);

const TITLE_WIDTHS: readonly DimensionValue[] = ['46%', '58%', '38%', '52%', '42%'];
const DETAIL_WIDTHS: readonly DimensionValue[] = ['28%', '34%', '24%', '31%', '26%'];

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
    const styles = stylesheet;
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

    const count = Math.max(1, Math.floor(props.rows ?? 2));
    const twoLines = (props.lines ?? 2) === 2;
    const color = theme.colors.border.default;
    return (
        <View
            testID={testID}
            accessibilityRole="progressbar"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ busy: true }}
            aria-busy
        >
            {Array.from({ length: count }, (_, index) => (
                <View
                    key={index}
                    testID={testID ? `${testID}-skeleton:${index}` : undefined}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[styles.row, rowBox, divided && index > 0 ? styles.rowDivided : null]}
                >
                    <HappierSkeletonBlock color={color} width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]!} height={10} radius={5} />
                    {twoLines ? (
                        <HappierSkeletonBlock
                            color={color}
                            width={DETAIL_WIDTHS[index % DETAIL_WIDTHS.length]!}
                            height={8}
                            radius={4}
                            style={styles.detail}
                        />
                    ) : null}
                </View>
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    // The page row's own box, so the swap to real rows does not move anything.
    row: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        justifyContent: 'center',
    },
    rowDivided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    detail: {
        marginTop: 8,
    },
    failedTitle: {
        color: theme.colors.text.secondary,
    },
}));
