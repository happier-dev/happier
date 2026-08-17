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
import { SelectionListColumnRow } from './SelectionListColumnRow';
import {
    resolveSelectionListSectionColumnCount,
    resolveSelectionListSectionColumnSpan,
} from './selectionListGridGeometry';
import { PlanOptionRow } from './SelectionListOptionRow';
import { SelectionListPaginationFooter } from './SelectionListPaginationFooter';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import {
    buildSelectionListGridRowModel,
    type SelectionListGridRowModel,
} from './selectionListGridRowModel';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import {
    collectVirtualizationEligibleSectionIds,
    maybeWarnAboutMultipleVirtualizedSections,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListPagination,
    SelectionListStep,
    SelectionListVirtualizedOptionSource,
    SelectionListVirtualizedOptionSourceItem,
} from './_types';
import type {
    SelectionListA11yPattern,
    SelectionListContainerA11yProps,
    SelectionListGridCellPlacement,
} from './buildSelectionListOptionA11yProps';
import { buildSelectionListSectionGroupA11yProps } from './buildSelectionListOptionA11yProps';

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
 *
 * The `option` arm, named on its own because the `columns` variant groups
 * these into visual rows and needs a handle on the arm itself. Declared
 * separately rather than `Extract`ed from the union below, which would make
 * the union circularly reference itself through the `option-row` arm.
 */
export type SelectionListBodyVirtualizedOptionItem = Readonly<{
    kind: 'option';
    rowKey: string;
    sectionId: string;
    option: SelectionListOption;
    isStale: boolean;
}>;

export type SelectionListBodyVirtualizedItem =
    | Readonly<{
          kind: 'section-header';
          rowKey: string;
          sectionId: string;
          title?: string;
          count?: number;
          isStale: boolean;
      }>
    | SelectionListBodyVirtualizedOptionItem
    /**
     * Lane G — one VISUAL row of the `columns` variant. Grouping the options
     * here (rather than teaching the virtualized backend about columns) keeps
     * the neutral virtualized-list seam free of backend-only escape hatches
     * like `numColumns` / `overrideItemLayout`, and makes `estimatedItemSize`
     * MORE accurate, because a grid row's height IS a row height.
     */
    | Readonly<{
          kind: 'option-row';
          rowKey: string;
          sectionId: string;
          options: ReadonlyArray<SelectionListBodyVirtualizedOptionItem>;
          /** Columns this row lays out — 1 for a full-width short section. */
          columnCount: number;
          /** Grid columns each of its cells occupies. */
          columnSpan: number;
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

/**
 * Lane G — fold consecutive option rows of ONE section into visual rows of up
 * to `columnCount` cells.
 *
 * Headers, skeletons, error / not-found / empty-hint rows are deliberately
 * left alone: they are full-width by nature and span the pane for free.
 *
 * A section with fewer options than there are columns gets ONE column, so its
 * card spans the pane rather than sitting beside a blank spacer. The rule is
 * owned by `resolveSelectionListSectionColumnCount` so the mapped renderer,
 * this one, and the arrow geometry cannot disagree.
 *
 * Grouping decides WHAT a row is; it does not number the rows.
 * `buildSelectionListGridRowModel` walks this output to assign every
 * `aria-rowindex`, because header rows take indices from the same sequence and
 * only one walk may own it.
 *
 * At `columnCount <= 1` this returns the SAME array reference it was given —
 * the single-column path is not merely equivalent, it is untouched.
 */
export function groupVirtualizedItemsIntoColumnRows(
    items: ReadonlyArray<SelectionListBodyVirtualizedItem>,
    columnCount: number,
): ReadonlyArray<SelectionListBodyVirtualizedItem> {
    if (!Number.isFinite(columnCount) || columnCount <= 1) return items;
    const count = Math.floor(columnCount);
    const grouped: SelectionListBodyVirtualizedItem[] = [];
    let pending: SelectionListBodyVirtualizedOptionItem[] = [];

    const flushPending = (): void => {
        if (pending.length === 0) return;
        const sectionColumnCount = resolveSelectionListSectionColumnCount(pending.length, count);
        const columnSpan = resolveSelectionListSectionColumnSpan(pending.length, count);
        for (let index = 0; index < pending.length; index += sectionColumnCount) {
            const cells = pending.slice(index, index + sectionColumnCount);
            grouped.push({
                kind: 'option-row',
                rowKey: `${cells[0].rowKey}::row`,
                sectionId: cells[0].sectionId,
                options: cells,
                columnCount: sectionColumnCount,
                columnSpan,
            });
        }
        pending = [];
    };

    for (const item of items) {
        if (item.kind === 'option') {
            // A section boundary always starts a new visual row, even in the
            // (currently impossible) case of two option runs meeting without
            // an intervening header.
            if (pending.length > 0 && pending[0].sectionId !== item.sectionId) flushPending();
            pending.push(item);
            continue;
        }
        flushPending();
        grouped.push(item);
    }
    flushPending();
    return grouped;
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
    /** Lane G — cells per visual row for `kind: 'option-row'` items. */
    columnCount?: number;
    /** Gutter between adjacent columns. Defaults to the shared list gutter. */
    columnGapPx?: number;
    /**
     * Popup-wide row numbering from the shared row model — `aria-rowindex` for
     * every row, plus the option-row ordinal the card gap reads. Absent in
     * `listbox` mode, which emits no row indices at all.
     */
    gridRowModel?: SelectionListGridRowModel;
    /** The body-owned pattern keeps flat rows aligned with every other renderer. */
    a11yPattern: SelectionListA11yPattern;
}>;

function renderFlatListboxSectionGroup(
    content: React.ReactElement,
    pattern: SelectionListA11yPattern,
    title?: string,
): React.ReactElement {
    const groupA11y = buildSelectionListSectionGroupA11yProps({ pattern, title });
    if (groupA11y === null) return content;
    return <View role="group" {...groupA11y}>{content}</View>;
}

function renderVirtualizedOptionCell(
    item: SelectionListBodyVirtualizedOptionItem,
    ctx: FlatRowRenderContext,
    cellPlacement?: SelectionListGridCellPlacement,
    rowIndex?: number,
): React.ReactElement {
    const dynStyles = selectionListDynamicRowStyles;
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
            measureMode={ctx.measureMode === true}
            {...(cellPlacement === undefined ? {} : { cellPlacement })}
            {...(rowIndex === undefined ? {} : { rowIndex })}
        />
    );
    return item.isStale
        ? <View style={dynStyles.staleSection}>{optionRow}</View>
        : optionRow;
}

function renderVirtualizedListRow(
    item: SelectionListBodyVirtualizedItem,
    ctx: FlatRowRenderContext,
): React.ReactElement | null {
    const dynStyles = selectionListDynamicRowStyles;
    const measureMode = ctx.measureMode === true;

    const placement = ctx.gridRowModel?.optionRowPlacementByRowKey.get(item.rowKey);

    if (item.kind === 'option') {
        return renderVirtualizedOptionCell(item, ctx, undefined, placement?.rowIndex);
    }

    if (item.kind === 'option-row') {
        return (
            <SelectionListColumnRow
                columnCount={item.columnCount}
                columnGapPx={ctx.columnGapPx}
                rowIndex={placement?.rowIndex}
                optionRowIndex={placement?.optionRowIndex}
            >
                {item.options.map((cell, columnIndex) => (
                    <React.Fragment key={cell.rowKey}>
                        {renderVirtualizedOptionCell(cell, ctx, {
                            columnIndex: columnIndex + 1,
                            columnSpan: item.columnSpan,
                        })}
                    </React.Fragment>
                ))}
            </SelectionListColumnRow>
        );
    }

    if (item.kind === 'section-header') {
        const headerRowIndex = ctx.gridRowModel?.headerRowIndexBySectionId.get(item.sectionId);
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        const headerTestId = selectionListTestId(sectionTestId, 'header');
        const wrapperStyle = item.isStale ? [styles.sectionWrap, dynStyles.staleSection] : styles.sectionWrap;
        const sectionGroupA11y = buildSelectionListSectionGroupA11yProps({
            pattern: ctx.a11yPattern,
            title: item.title,
        });
        return (
            <View
                testID={measureMode ? undefined : sectionTestId}
                style={wrapperStyle}
                {...(sectionGroupA11y ?? {})}
                {...(sectionGroupA11y === null ? {} : { role: 'group' as const })}
            >
                <SelectionListSectionHeader
                    testID={measureMode ? undefined : headerTestId}
                    title={item.title}
                    count={item.count}
                    {...(measureMode || headerRowIndex === undefined
                        ? {}
                        : { gridRow: { rowIndex: headerRowIndex, columnCount: ctx.columnCount ?? 1 } })}
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
        return renderFlatListboxSectionGroup((
            <SelectionListErrorRow
                label={item.label}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'error')}
                measureMode={measureMode}
            />
        ), ctx.a11yPattern);
    }

    if (item.kind === 'not-found') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return renderFlatListboxSectionGroup((
            <SelectionListNotFoundRow
                label={item.label}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'notFound')}
                measureMode={measureMode}
            />
        ), ctx.a11yPattern);
    }

    if (item.kind === 'empty-hint') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return renderFlatListboxSectionGroup((
            <SelectionListEmptyHintRow
                hint={item.hint}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'emptyHint')}
            />
        ), ctx.a11yPattern);
    }

    return null;
}

function useSelectionListVirtualizedPagination(args: Readonly<{
    pagination: SelectionListPagination | undefined;
    measureMode: boolean;
    rootTestID: string | undefined;
    a11yPattern: SelectionListA11yPattern;
}>) {
    const deliveredRequestKeyRef = React.useRef<{
        key: string | null;
        source: 'end' | 'retry';
    } | null>(null);
    const wasLoadingMoreRef = React.useRef(args.pagination?.loadingMore === true);
    const pagination = args.pagination;
    const handleEndReached = React.useCallback(() => {
        if (
            args.measureMode
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
    }, [args.measureMode, pagination]);
    const handleRetry = React.useCallback(() => {
        if (args.measureMode || !pagination?.onRetry || pagination.loadingMore) return;
        if (
            deliveredRequestKeyRef.current?.key === pagination.requestKey
            && deliveredRequestKeyRef.current.source === 'retry'
        ) return;
        deliveredRequestKeyRef.current = { key: pagination.requestKey, source: 'retry' };
        pagination.onRetry();
    }, [args.measureMode, pagination]);
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
    const footer = pagination ? (
        <SelectionListPaginationFooter
            pagination={pagination}
            rootTestID={args.rootTestID}
            measureMode={args.measureMode}
            a11yPattern={args.a11yPattern}
            onRetry={handleRetry}
        />
    ) : null;

    return {
        onEndReached: pagination && pagination.hasMore && !pagination.loadingMore && !pagination.error
            ? handleEndReached
            : undefined,
        footer,
    };
}

/**
 * RV-9 / FRESH-3 — Single virtualized list rendering ALL sections (headers +
 * option rows + dynamic-state rows) as a flat list. Used when a
 * virtualization-eligible section has neighbors. Avoids competing
 * per-section/body scroll owners and keeps trailing sections fully
 * scrollable.
 */
type SelectionListBodyVirtualizedProps = Readonly<{
    rootTestID: string | undefined;
    listboxAria: SelectionListContainerA11yProps | null;
    plan: ReadonlyArray<SectionRenderPlan>;
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource;
    stepId: string;
    selectedOptionId: string | null;
    focusedOptionId: string | null;
    focusedOptionIndex?: number;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    showsVerticalScrollIndicator?: boolean;
    pagination?: SelectionListPagination;
    /** FR3-1 / FR3-8 — identity-free measure mode. */
    measureMode?: boolean;
    /** Lane G — resolved column count. `1` (or omitted) = classic flat rows. */
    columnCount?: number;
    /** Gutter between adjacent columns. Defaults to the shared list gutter. */
    columnGapPx?: number;
}>;

export function SelectionListBodyVirtualized(props: SelectionListBodyVirtualizedProps): React.ReactElement {
    if (props.virtualizedOptionSource) {
        return <SelectionListBodyDirectVirtualizedSource {...props} source={props.virtualizedOptionSource} />;
    }
    return <SelectionListBodyFlattenedVirtualized {...props} />;
}

function SelectionListBodyFlattenedVirtualized(props: SelectionListBodyVirtualizedProps): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const columnCount = props.columnCount ?? 1;
    const columnGapPx = props.columnGapPx;
    const flatItems = React.useMemo(
        () => groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList(props.plan),
            columnCount,
        ),
        [props.plan, columnCount],
    );
    // Row numbering exists only in `grid` mode. The same body-owned pattern
    // also decides whether flat section rows become listbox groups, so this
    // renderer cannot disagree with the container's role.
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    const gridRowModel = React.useMemo(
        () => (a11yPattern === 'grid' ? buildSelectionListGridRowModel(flatItems) : null),
        [a11yPattern, flatItems],
    );
    const optionPositions = React.useMemo(() => {
        const byId = new Map<string, number>();
        let position = 0;
        for (const item of flatItems) {
            if (item.kind === 'option') {
                position += 1;
                byId.set(item.option.id, position);
                continue;
            }
            if (item.kind !== 'option-row') continue;
            // Row-major grouping means reading order and set position agree.
            for (const cell of item.options) {
                position += 1;
                byId.set(cell.option.id, position);
            }
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
        const index = flatItems.findIndex((row) => {
            if (row.kind === 'option') return row.option.id === focusedOptionId;
            // A focused cell brings its whole visual row into view.
            if (row.kind === 'option-row') {
                return row.options.some((cell) => cell.option.id === focusedOptionId);
            }
            return false;
        });
        if (index < 0) return;
        ref.scrollToIndex({ index, viewPosition: 0.5, animated: !reducedMotion });
    }, [focusedOptionId, flatItems, reducedMotion]);

    const measureMode = props.measureMode === true;
    const { onEndReached, footer: paginationFooter } = useSelectionListVirtualizedPagination({
        pagination: props.pagination,
        measureMode,
        rootTestID: props.rootTestID,
        a11yPattern,
    });
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
                columnCount,
                columnGapPx,
                a11yPattern,
                ...(gridRowModel === null ? {} : { gridRowModel }),
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
            columnCount,
            columnGapPx,
            gridRowModel,
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
                onEndReached={onEndReached}
                onEndReachedThreshold={props.pagination ? 0.35 : undefined}
                ListFooterComponent={paginationFooter}
            />
        </View>
    );
}

type DirectVirtualizedSourceRowContext = Readonly<{
    source: SelectionListVirtualizedOptionSource;
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionId: string | null;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    measureMode: boolean;
    a11yPattern: SelectionListA11yPattern;
}>;

function renderDirectVirtualizedSourceItem(
    item: SelectionListVirtualizedOptionSourceItem,
    ctx: DirectVirtualizedSourceRowContext,
): React.ReactElement {
    if (item.kind === 'section-header') {
        const header = ctx.source.getHeader(item.sectionIndex);
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', header.id);
        const headerTestId = selectionListTestId(sectionTestId, 'header');
        const sectionGroupA11y = buildSelectionListSectionGroupA11yProps({
            pattern: ctx.a11yPattern,
            title: header.title,
        });
        return (
            <View
                testID={ctx.measureMode ? undefined : sectionTestId}
                style={styles.sectionWrap}
                {...(sectionGroupA11y ?? {})}
                {...(sectionGroupA11y === null ? {} : { role: 'group' as const })}
            >
                <SelectionListSectionHeader
                    testID={ctx.measureMode ? undefined : headerTestId}
                    title={header.title}
                    count={header.count}
                />
            </View>
        );
    }

    const option = ctx.source.getOption(item.optionIndex);
    return (
        <PlanOptionRow
            option={option}
            rootTestID={ctx.rootTestID}
            stepId={ctx.stepId}
            isSelected={ctx.selectedOptionId === option.id}
            isFocused={ctx.focusedOptionId !== null && ctx.focusedOptionId === option.id}
            onSelect={ctx.onSelect}
            onPushStep={ctx.onPushStep}
            positionInSet={item.positionInSet}
            setSize={ctx.source.optionCount}
            measureMode={ctx.measureMode}
        />
    );
}

function SelectionListBodyDirectVirtualizedSource(props: SelectionListBodyVirtualizedProps & Readonly<{
    source: SelectionListVirtualizedOptionSource;
}>): React.ReactElement {
    const source = props.source;
    const sourceStateKey = source.stateKey;
    const reducedMotion = useReducedMotionPreference();
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const focusedOptionIndex = props.focusedOptionIndex ?? (
        props.focusedOptionId === null
            ? -1
            : source.findOptionIndexById(props.focusedOptionId)
    );
    React.useEffect(() => {
        if (focusedOptionIndex < 0) return;
        const ref = virtualizedListRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        const itemIndex = source.items.findIndex((item) => (
            item.kind === 'option' && item.optionIndex === focusedOptionIndex
        ));
        if (itemIndex < 0) return;
        ref.scrollToIndex({ index: itemIndex, viewPosition: 0.5, animated: !reducedMotion });
    }, [focusedOptionIndex, source.items, reducedMotion]);

    const measureMode = props.measureMode === true;
    const { onEndReached, footer: paginationFooter } = useSelectionListVirtualizedPagination({
        pagination: props.pagination,
        measureMode,
        rootTestID: props.rootTestID,
        a11yPattern,
    });
    const renderItem = React.useCallback(
        ({ item }: { item: SelectionListVirtualizedOptionSourceItem }) => renderDirectVirtualizedSourceItem(item, {
            source,
            rootTestID: props.rootTestID,
            stepId: props.stepId,
            selectedOptionId: props.selectedOptionId,
            focusedOptionId: props.focusedOptionId,
            onSelect: props.onSelect,
            onPushStep: props.onPushStep,
            measureMode,
            a11yPattern,
        }),
        [
            source,
            sourceStateKey,
            props.rootTestID,
            props.stepId,
            props.selectedOptionId,
            props.focusedOptionId,
            props.onSelect,
            props.onPushStep,
            measureMode,
            a11yPattern,
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
                data={source.items}
                extraData={sourceStateKey}
                keyExtractor={(item: SelectionListVirtualizedOptionSourceItem) => (
                    item.kind === 'section-header'
                        ? `${source.getHeader(item.sectionIndex).id}::header`
                        : source.getOptionId(item.optionIndex)
                )}
                renderItem={renderItem}
                getItemType={(item: SelectionListVirtualizedOptionSourceItem) => item.kind}
                estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                recycleItems={false}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                onEndReached={onEndReached}
                onEndReachedThreshold={props.pagination ? 0.35 : undefined}
                ListFooterComponent={paginationFooter}
            />
        </View>
    );
}
