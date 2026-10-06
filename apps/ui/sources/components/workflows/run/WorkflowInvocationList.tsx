import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import {
    Platform,
    View,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';

import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
    describeWorkflowInvocationAttempt,
    describeWorkflowInvocationLifecycle,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';

/**
 * The Run's invocation outline.
 *
 * Rows are the canonical index the server returned, in the order it returned
 * them. Pagination is presentation infrastructure, not a completeness cliff:
 * every admitted row stays reachable, and a still-loading page says so instead
 * of looking like the end of history.
 *
 * Counters render the canonical decimal strings verbatim. They are never parsed
 * into numbers, because these counters are 64-bit on the server and a JSON
 * number would silently lose precision.
 */

/**
 * Rows and the paging action take the platform target as a real minimum
 * height. `hitSlop` is inert on react-native-web's `Pressable`, and the desktop
 * app IS the web bundle.
 */
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

const styles = StyleSheet.create((theme) => ({
    scroll: {
        flex: 1,
    },
    list: {
        gap: theme.margins.xs,
    },
    listHeader: {
        marginBottom: theme.margins.lg,
    },
    listFooter: {
        marginTop: theme.margins.lg,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingVertical: theme.margins.sm,
        minHeight: MINIMUM_TARGET_SIZE,
        borderWidth: 1,
        borderColor: 'transparent',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    rail: {
        width: StyleSheet.hairlineWidth,
        alignSelf: 'stretch',
        backgroundColor: theme.colors.border.default,
    },
    label: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    labelSelected: {
        ...Typography.default('semiBold'),
    },
    ordinal: {
        ...Typography.default('regular'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    trailing: {
        marginLeft: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    footer: {
        paddingVertical: theme.margins.md,
        alignItems: 'center',
    },
    footerTarget: {
        minHeight: MINIMUM_TARGET_SIZE,
        borderWidth: 1,
        borderColor: 'transparent',
        justifyContent: 'center',
    },
    footerError: {
        alignItems: 'center',
        gap: theme.margins.xs,
    },
    footerAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    footerNote: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    empty: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        paddingVertical: theme.margins.md,
    },
}));

export type WorkflowInvocationListProps = Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    selectedInvocationId: string | null;
    /** The press event travels so the caller can return focus to this row later. */
    onSelectInvocation: (invocationId: string, event?: Parameters<React.ComponentProps<typeof HappierPressable>['onPress']>[0]) => void;
    /** Present only while the canonical reader reports another page. */
    onLoadMore?: () => void;
    loadingMore?: boolean;
    /**
     * That next page could not be loaded. Every loaded row stays and the cursor
     * is untouched; only the paging action becomes the reason plus a Retry that
     * asks for exactly the same page again.
     */
    loadMoreFailed?: boolean;
    loaded: boolean;
    resolveInvocationLabel?: (invocation: WorkflowRunInvocationIndexV1) => string | null;
    /** The authored block kind for a row, so a held Wait-for-you step reads its own word. */
    resolveInvocationBlockKind?: (invocation: WorkflowRunInvocationIndexV1) => string | null;
    ListHeaderComponent?: React.ReactElement | null;
    ListFooterComponent?: React.ReactElement | null;
    contentContainerStyle?: StyleProp<ViewStyle>;
    listRef?: React.Ref<VirtualizedListRef>;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    testIDPrefix?: string;
}>;

export function WorkflowInvocationList(props: WorkflowInvocationListProps): React.ReactElement {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'workflow-invocations';
    const keyExtractor = React.useCallback((invocation: WorkflowRunInvocationIndexV1) => invocation.id, []);
    const renderInvocation = React.useCallback(({ item: invocation }: { item: WorkflowRunInvocationIndexV1 }) => {
        const selected = props.selectedInvocationId === invocation.id;
        const blockKind = props.resolveInvocationBlockKind?.(invocation) ?? null;
        const stateLabel = describeWorkflowInvocationLifecycle(invocation.lifecycle, { blockKind }).label;
        const attempt = describeWorkflowInvocationAttempt(invocation.attempt);
        const displayLabel = props.resolveInvocationLabel?.(invocation) ?? t('workflows.contentUnavailable');
        return (
            <HappierPressable
                testID={`${testIDPrefix}-row-${invocation.id}`}
                accessibilityRole="button"
                current={selected ? 'page' : undefined}
                accessibilityLabel={t('workflows.a11y.flowNode', {
                    node: attempt.retried ? `${displayLabel} · ${attempt.label}` : displayLabel,
                    state: stateLabel,
                })}
                onPress={(event) => props.onSelectInvocation(invocation.id, event)}
                style={(state) => [styles.row, selected ? styles.rowSelected : null, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            >
                <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.rail}
                />
                <Text style={styles.ordinal}>{invocation.memberOrdinal}</Text>
                <Text style={[styles.label, selected ? styles.labelSelected : null]} numberOfLines={1}>
                    {displayLabel}
                </Text>
                <View style={styles.trailing}>
                    {attempt.retried ? (
                        <Text testID={`${testIDPrefix}-attempt-${invocation.id}`} style={styles.ordinal}>
                            {attempt.label}
                        </Text>
                    ) : null}
                    <WorkflowLifecycleStatus
                        testID={`${testIDPrefix}-state-${invocation.id}`}
                        lifecycle={invocation.lifecycle}
                        blockKind={blockKind}
                    />
                </View>
            </HappierPressable>
        );
    }, [props.onSelectInvocation, props.resolveInvocationBlockKind, props.resolveInvocationLabel, props.selectedInvocationId, testIDPrefix, theme.colors.border.focus]);

    const pagingFooter = props.onLoadMore === undefined ? null : (
        <View style={styles.footer}>
            {props.loadMoreFailed === true ? (
                // The rows above are unaffected; only this page is missing.
                <View
                    testID={`${testIDPrefix}-load-more-error`}
                    accessibilityRole="alert"
                    style={styles.footerError}
                >
                    <Text style={styles.footerNote}>{t('workflows.loadFailedBody')}</Text>
                    <HappierPressable
                        testID={`${testIDPrefix}-load-more-retry`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.retry')}
                        disabled={props.loadingMore === true}
                        onPress={props.onLoadMore}
                        style={(state) => [styles.footerTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={styles.footerAction}>{t('workflows.retry')}</Text>
                    </HappierPressable>
                </View>
            ) : props.loadingMore === true ? (
                <Text testID={`${testIDPrefix}-loading-more`} style={styles.footerNote}>
                    {t('common.loading')}
                </Text>
            ) : (
                <HappierPressable
                    testID={`${testIDPrefix}-load-more`}
                    accessibilityRole="button"
                    onPress={props.onLoadMore}
                    style={(state) => [styles.footerTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.footerAction}>{t('workflows.run.loadMore')}</Text>
                </HappierPressable>
            )}
        </View>
    );

    return (
        <View accessibilityRole="list" style={styles.scroll}>
            <VirtualizedList
                ref={props.listRef}
                testID={testIDPrefix}
                backendPreference="auto"
                style={styles.scroll}
                data={props.invocations}
                keyExtractor={keyExtractor}
                renderItem={renderInvocation}
                contentContainerStyle={[styles.list, props.contentContainerStyle]}
                onScroll={props.onScroll}
                scrollEventThrottle={32}
                ListHeaderComponent={props.ListHeaderComponent === null || props.ListHeaderComponent === undefined
                    ? null
                    : <View style={styles.listHeader}>{props.ListHeaderComponent}</View>}
                // A first page still in flight says so; it must not read as a
                // Run with no history. Once loaded, no rows means nothing has
                // started yet in this Run — not the collection's empty copy.
                ListEmptyComponent={props.loaded ? (
                    <Text testID={`${testIDPrefix}-empty`} style={styles.empty}>
                        {t('workflows.run.notStarted')}
                    </Text>
                ) : (
                    <Text testID={`${testIDPrefix}-loading`} style={styles.empty}>
                        {t('common.loading')}
                    </Text>
                )}
                ListFooterComponent={pagingFooter === null && props.ListFooterComponent === null
                    ? null
                    : (
                        <>
                            {pagingFooter}
                            {props.ListFooterComponent === null || props.ListFooterComponent === undefined
                                ? null
                                : <View style={styles.listFooter}>{props.ListFooterComponent}</View>}
                        </>
                    )}
            />
        </View>
    );
}
