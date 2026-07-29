/**
 * FR4-W2-BODY — single-owner virtualized rendering path extracted from
 * `SelectionListBody.tsx`.
 *
 * RV-9 / FRESH-3 — when a virtualization-eligible section has neighboring
 * sections (or a single eligible section is in a stale dynamic state), the
 * body collapses ALL sections (headers + option rows + dynamic-state rows)
 * into one flat virtualized list. This avoids competing section/body scroll owners
 * and keeps every focused row reachable.
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import {
    SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS,
    SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX,
} from './_constants';
import {
    SelectionListEmptyHintRow,
    SelectionListErrorRow,
    SelectionListLoadingSkeletonRow,
    SelectionListNotFoundRow,
    selectionListDynamicRowStyles,
} from './SelectionListDynamicSectionRows';
import { PlanOptionRow } from './SelectionListOptionRow';
import { SelectionListPaginationFooter } from './SelectionListPaginationFooter';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import {
    collectVirtualizationEligibleSectionIds,
    maybeWarnAboutMultipleVirtualizedSections,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type { SelectionListOption, SelectionListPagination, SelectionListStep } from './_types';

type ListboxAriaProps = Readonly<{ id: string; role: 'listbox' }>;

const styles = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
    virtualizedHost: {
        // RV-9: ensure the flat virtualized list has a measurable host. Mirrors
        // `SelectionListVirtualizedSection.virtualizedHost`.
        minHeight: 56 * 4,
    },
    sectionWrap: {
        flexDirection: 'column',
    },
}));

/**
 * RV-9 / FRESH-3 — Flat-row representation of the render plan consumed by
 * the single virtualized list multi-section body path. Each row is a discriminated
 * union so virtualized list's `getItemType(item)` can pool recycled views by type.
 *
 * The selection / focus state is intentionally NOT embedded in the flat
 * items: the body's `renderItem` closure reads it from the latest props,
 * keeping items value-stable across keyboard navigation and avoiding
 * recycler churn.
 */
export type SelectionListBodyVirtualizedItem =
    | Readonly<{
          kind: 'section-header';
          rowKey: string;
          sectionId: string;
          title?: string;
          count?: number;
          isStale: boolean;
      }>
    | Readonly<{
          kind: 'option';
          rowKey: string;
          sectionId: string;
          option: SelectionListOption;
          isStale: boolean;
      }>
    | Readonly<{
          kind: 'loading-skeleton';
          rowKey: string;
          sectionId: string;
          index: number;
      }>
    | Readonly<{
          kind: 'error';
          rowKey: string;
          sectionId: string;
          label: string;
      }>
    | Readonly<{
          kind: 'not-found';
          rowKey: string;
          sectionId: string;
          label: string;
      }>
    | Readonly<{
          kind: 'empty-hint';
          rowKey: string;
          sectionId: string;
          hint: string;
      }>;

/**
 * RV-9 / FRESH-3: flatten the render plan into a typed row array for the
 * single virtualized list path. The flattening mirrors the per-section branching
 * in `renderSectionElement` (loading, error, notFound, empty, success) but
 * emits one flat row per visible element so virtualized list recycles them
 * uniformly across sections.
 */
export function flattenRenderPlanForVirtualizedList(
    plan: ReadonlyArray<SectionRenderPlan>,
): ReadonlyArray<SelectionListBodyVirtualizedItem> {
    const rows: SelectionListBodyVirtualizedItem[] = [];
    for (const sectionPlan of plan) {
        // Empty-hint sections with no hint render NOTHING in the per-section
        // renderer; preserve that behavior so the flat path is visually
        // identical.
        if (
            sectionPlan.dynamicState === 'empty'
            && (sectionPlan.hint === undefined || sectionPlan.hint.length === 0)
        ) {
            continue;
        }

        const isStale = sectionPlan.isStale === true;

        rows.push({
            kind: 'section-header',
            rowKey: `${sectionPlan.id}::header`,
            sectionId: sectionPlan.id,
            title: sectionPlan.title,
            count: sectionPlan.count,
            isStale,
        });

        if (sectionPlan.dynamicState === 'loading') {
            const skeletonCount = sectionPlan.skeletonRowCount
                ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS;
            for (let i = 0; i < skeletonCount; i += 1) {
                rows.push({
                    kind: 'loading-skeleton',
                    rowKey: `${sectionPlan.id}::skeleton::${i}`,
                    sectionId: sectionPlan.id,
                    index: i,
                });
            }
            // When a loading section carries stale options (refetch path),
            // render them after the skeletons so the user can still interact
            // while the new data arrives (mirrors `renderSectionElement`).
            if (isStale && sectionPlan.options.length > 0) {
                for (const option of sectionPlan.options) {
                    rows.push({
                        kind: 'option',
                        rowKey: `${sectionPlan.id}::option::${option.id}`,
                        sectionId: sectionPlan.id,
                        option,
                        isStale: true,
                    });
                }
            }
            continue;
        }

        if (sectionPlan.dynamicState === 'error') {
            const label = sectionPlan.hint ?? t('selectionList.dynamicSectionError');
            rows.push({
                kind: 'error',
                rowKey: `${sectionPlan.id}::error`,
                sectionId: sectionPlan.id,
                label,
            });
            // Stale options below the error row, matching the per-section
            // renderer's behavior.
            if (sectionPlan.options.length > 0) {
                for (const option of sectionPlan.options) {
                    rows.push({
                        kind: 'option',
                        rowKey: `${sectionPlan.id}::option::${option.id}`,
                        sectionId: sectionPlan.id,
                        option,
                        isStale: true,
                    });
                }
            }
            continue;
        }

        if (sectionPlan.dynamicState === 'notFound') {
            const label = sectionPlan.hint ?? t('selectionList.pathNotFound');
            rows.push({
                kind: 'not-found',
                rowKey: `${sectionPlan.id}::notFound`,
                sectionId: sectionPlan.id,
                label,
            });
            continue;
        }

        if (sectionPlan.dynamicState === 'empty') {
            // `sectionPlan.hint` is guaranteed non-empty here (the early-exit
            // above filters undefined/empty hints).
            rows.push({
                kind: 'empty-hint',
                rowKey: `${sectionPlan.id}::emptyHint`,
                sectionId: sectionPlan.id,
                hint: sectionPlan.hint as string,
            });
            continue;
        }

        // Success: emit each option row.
        for (const option of sectionPlan.options) {
            rows.push({
                kind: 'option',
                rowKey: `${sectionPlan.id}::option::${option.id}`,
                sectionId: sectionPlan.id,
                option,
                isStale,
            });
        }
    }
    return rows;
}

type FlatRowRenderContext = Readonly<{
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionId: string | null;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById: ReadonlyMap<string, number>;
    optionSetSize: number;
    /** FR3-1 / FR3-8 — identity-free measure rendering. */
    measureMode?: boolean;
}>;

function renderVirtualizedListRow(
    item: SelectionListBodyVirtualizedItem,
    ctx: FlatRowRenderContext,
): React.ReactElement | null {
    const dynStyles = selectionListDynamicRowStyles;
    const measureMode = ctx.measureMode === true;

    if (item.kind === 'option') {
        const isSelected = ctx.selectedOptionId === item.option.id;
        const isFocused = ctx.focusedOptionId !== null && ctx.focusedOptionId === item.option.id;
        const optionRow = (
            <PlanOptionRow
                option={item.option}
                rootTestID={ctx.rootTestID}
                stepId={ctx.stepId}
                isSelected={isSelected}
                isFocused={isFocused}
                onSelect={ctx.onSelect}
                onPushStep={ctx.onPushStep}
                positionInSet={ctx.optionPositionById.get(item.option.id) ?? 1}
                setSize={ctx.optionSetSize}
                measureMode={measureMode}
            />
        );
        return item.isStale
            ? <View style={dynStyles.staleSection}>{optionRow}</View>
            : optionRow;
    }

    if (item.kind === 'section-header') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        const headerTestId = selectionListTestId(sectionTestId, 'header');
        const wrapperStyle = item.isStale ? [styles.sectionWrap, dynStyles.staleSection] : styles.sectionWrap;
        return (
            <View testID={measureMode ? undefined : sectionTestId} style={wrapperStyle}>
                <SelectionListSectionHeader
                    testID={measureMode ? undefined : headerTestId}
                    title={item.title}
                    count={item.count}
                />
            </View>
        );
    }

    if (item.kind === 'loading-skeleton') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return (
            <View
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'loading')}
                {...(measureMode
                    ? {}
                    : ({ accessibilityHidden: true, 'aria-hidden': true } as Record<string, unknown>))}
            >
                <SelectionListLoadingSkeletonRow
                    index={item.index}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'loading', `row-${item.index}`)}
                />
            </View>
        );
    }

    if (item.kind === 'error') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return (
            <SelectionListErrorRow
                label={item.label}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'error')}
                measureMode={measureMode}
            />
        );
    }

    if (item.kind === 'not-found') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return (
            <SelectionListNotFoundRow
                label={item.label}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'notFound')}
                measureMode={measureMode}
            />
        );
    }

    if (item.kind === 'empty-hint') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return (
            <SelectionListEmptyHintRow
                hint={item.hint}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'emptyHint')}
            />
        );
    }

    return null;
}

/**
 * RV-9 / FRESH-3 — Single virtualized list rendering ALL sections (headers +
 * option rows + dynamic-state rows) as a flat list. Used when a
 * virtualization-eligible section has neighbors. Avoids competing
 * per-section/body scroll owners and keeps trailing sections fully
 * scrollable.
 */
export function SelectionListBodyVirtualized(props: Readonly<{
    rootTestID: string | undefined;
    listboxAria: ListboxAriaProps | null;
    plan: ReadonlyArray<SectionRenderPlan>;
    stepId: string;
    selectedOptionId: string | null;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    showsVerticalScrollIndicator?: boolean;
    pagination?: SelectionListPagination;
    /** FR3-1 / FR3-8 — identity-free measure mode. */
    measureMode?: boolean;
}>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const flatItems = React.useMemo(
        () => flattenRenderPlanForVirtualizedList(props.plan),
        [props.plan],
    );
    const optionPositions = React.useMemo(() => {
        const byId = new Map<string, number>();
        let position = 0;
        for (const item of flatItems) {
            if (item.kind !== 'option') continue;
            position += 1;
            byId.set(item.option.id, position);
        }
        return { byId, setSize: position };
    }, [flatItems]);

    // RV-9: dev-only deduplicated warning about descriptor mis-configuration
    // (multi-virtualized eligible sections are now supported but probably
    // indicate the descriptor could be simplified). Fires at most once per
    // signature per JS realm.
    React.useEffect(() => {
        maybeWarnAboutMultipleVirtualizedSections(
            collectVirtualizationEligibleSectionIds(props.plan),
        );
    }, [props.plan]);

    // RV-9: scroll-to-focused-row across the flattened item list. Compute
    // the flat-index of the focused option; ask virtualized list to bring it into
    // view centered.
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const focusedOptionId = props.focusedOptionId;
    React.useEffect(() => {
        if (focusedOptionId === null) return;
        const ref = virtualizedListRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        const index = flatItems.findIndex(
            (row) => row.kind === 'option' && row.option.id === focusedOptionId,
        );
        if (index < 0) return;
        ref.scrollToIndex({ index, viewPosition: 0.5, animated: !reducedMotion });
    }, [focusedOptionId, flatItems, reducedMotion]);

    const measureMode = props.measureMode === true;
    const deliveredRequestKeyRef = React.useRef<{
        key: string | null;
        source: 'end' | 'retry';
    } | null>(null);
    const wasLoadingMoreRef = React.useRef(props.pagination?.loadingMore === true);
    const pagination = props.pagination;
    const handleEndReached = React.useCallback(() => {
        if (
            measureMode
            || !pagination
            || !pagination.hasMore
            || pagination.loadingMore
            || pagination.error
        ) {
            return;
        }
        if (deliveredRequestKeyRef.current?.key === pagination.requestKey) return;
        deliveredRequestKeyRef.current = { key: pagination.requestKey, source: 'end' };
        pagination.onEndReached();
    }, [measureMode, pagination]);
    const handleRetry = React.useCallback(() => {
        if (measureMode || !pagination?.onRetry || pagination.loadingMore) return;
        if (
            deliveredRequestKeyRef.current?.key === pagination.requestKey
            && deliveredRequestKeyRef.current.source === 'retry'
        ) return;
        deliveredRequestKeyRef.current = { key: pagination.requestKey, source: 'retry' };
        pagination.onRetry();
    }, [measureMode, pagination]);
    React.useEffect(() => {
        if (
            deliveredRequestKeyRef.current?.key !== pagination?.requestKey
            || (pagination?.error && deliveredRequestKeyRef.current?.source === 'end')
            || (
                wasLoadingMoreRef.current
                && pagination?.loadingMore === false
                && pagination.error
                && deliveredRequestKeyRef.current?.source === 'retry'
            )
        ) {
            deliveredRequestKeyRef.current = null;
        }
        wasLoadingMoreRef.current = pagination?.loadingMore === true;
    }, [pagination?.error, pagination?.loadingMore, pagination?.requestKey]);
    const paginationFooter = pagination ? (
        <SelectionListPaginationFooter
            pagination={pagination}
            rootTestID={props.rootTestID}
            measureMode={measureMode}
            onRetry={handleRetry}
        />
    ) : null;
    const renderItem = React.useCallback(
        ({ item }: { item: SelectionListBodyVirtualizedItem }) =>
            renderVirtualizedListRow(item, {
                rootTestID: props.rootTestID,
                stepId: props.stepId,
                selectedOptionId: props.selectedOptionId,
                focusedOptionId: props.focusedOptionId,
                onSelect: props.onSelect,
                onPushStep: props.onPushStep,
                optionPositionById: optionPositions.byId,
                optionSetSize: optionPositions.setSize,
                measureMode,
            }),
        [
            props.rootTestID,
            props.stepId,
            props.selectedOptionId,
            props.focusedOptionId,
            props.onSelect,
            props.onPushStep,
            optionPositions,
            measureMode,
        ],
    );

    const hostAccessibilityHide = measureMode
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
            pointerEvents: 'none' as const,
            'aria-hidden': true,
        }
        : null;

    return (
        <View
            testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'body')}
            style={[styles.body, styles.virtualizedHost]}
            {...(measureMode || props.listboxAria === null
                ? {}
                : (props.listboxAria as unknown as Record<string, never>))}
            {...(hostAccessibilityHide ?? {})}
        >
            <VirtualizedList
                ref={virtualizedListRef}
                testID={measureMode
                    ? undefined
                    : selectionListTestId(props.rootTestID, 'bodyVirtualizedList')}
                data={flatItems as SelectionListBodyVirtualizedItem[]}
                keyExtractor={(item: SelectionListBodyVirtualizedItem) => item.rowKey}
                renderItem={renderItem}
                getItemType={(item: SelectionListBodyVirtualizedItem) => item.kind}
                estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                recycleItems={false}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                onEndReached={pagination && pagination.hasMore && !pagination.loadingMore && !pagination.error
                    ? handleEndReached
                    : undefined}
                onEndReachedThreshold={pagination ? 0.35 : undefined}
                ListFooterComponent={paginationFooter}
            />
        </View>
    );
}
