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
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
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
    SelectionListResultHintRow,
    selectionListDynamicRowStyles,
} from './SelectionListDynamicSectionRows';
import { chunkIntoColumnBlocks, SelectionListColumnRow } from './SelectionListColumnRow';
import { resolveSelectionListOptionDomId } from './resolveSelectionListOptionDomId';
import {
    resolveSelectionListSectionColumnCount,
    resolveSelectionListSectionColumnSpan,
} from './selectionListGridGeometry';
import { SelectionListVirtualizedOptionRow, SelectionListVirtualizedRowStateProvider } from './SelectionListVirtualizedRowState';
import { SelectionListPaginationFooter } from './SelectionListPaginationFooter';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { SelectionListScrollIntoViewContext, type SelectionListRegisterScrollItemLayout } from './SelectionListScrollIntoViewContext';
import {
    buildSelectionListGridRowModel,
    type SelectionListGridRowModel,
} from './selectionListGridRowModel';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import {
    collectVirtualizationEligibleSectionIds,
    maybeWarnAboutMultipleVirtualizedSections,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListLazyVisual,
    SelectionListPagination,
    SelectionListSectionAction,
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
import { useSelectionListVirtualizedFocusReveal } from './useSelectionListVirtualizedFocusReveal';

const styles = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
    virtualizedHost: {
        position: 'relative',
        // RV-9: a four-row fallback for a caller that declares no bound; a
        // declared `maxHeight` replaces it (`viewportHeight`). No minimum, so a
        // short modal/keyboard/rotation viewport remains authoritative.
        height: SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX * 4,
        maxHeight: '100%',
        minHeight: 0,
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
          rightAccessory?: SelectionListLazyVisual;
          count?: number;
          action?: SelectionListSectionAction;
          isStale: boolean;
      }>
    | SelectionListBodyVirtualizedOptionItem
    /**
     * One BLOCK of the `columns` variant: options laid out as independent
     * column stacks. Grouping the options here (rather than teaching the
     * virtualized backend about columns) keeps the neutral virtualized-list seam
     * free of backend-only escape hatches like `numColumns` / `overrideItemLayout`.
     */
    | Readonly<{
          kind: 'option-row';
          rowKey: string;
          sectionId: string;
          options: ReadonlyArray<SelectionListBodyVirtualizedOptionItem>;
          /** Columns this block lays out — 1 for a full-width short section. */
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
          retry?: Readonly<{ label: string; onPress: () => void }>;
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
          /** The line a section that names its first load shows while it loads. */
          loading?: boolean;
      }>
    | Readonly<{
          kind: 'result-hint';
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
        // Last-known rows being refreshed keep their ink; only rows a failed refresh left behind are dimmed.
        const dimStale = isStale && sectionPlan.dynamicState === 'error';

        rows.push({
            kind: 'section-header',
            rowKey: `${sectionPlan.id}::header`,
            sectionId: sectionPlan.id,
            title: sectionPlan.title,
            rightAccessory: sectionPlan.rightAccessory,
            count: sectionPlan.count,
            action: sectionPlan.action,
            isStale: dimStale,
        });

        if (sectionPlan.dynamicState === 'loading') {
            const skeletonCount = sectionPlan.skeletonRowCount
                ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS;
            // A section that names its first load says so in one quiet line instead of skeletons.
            if (skeletonCount === 0 && sectionPlan.hint && !isStale) {
                rows.push({
                    kind: 'empty-hint',
                    rowKey: `${sectionPlan.id}::loadingHint`,
                    sectionId: sectionPlan.id,
                    hint: sectionPlan.hint,
                    loading: true,
                });
            }
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
                        isStale: false,
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
                ...(sectionPlan.retry ? { retry: sectionPlan.retry } : {}),
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
        if (sectionPlan.resultHint !== undefined && sectionPlan.resultHint.length > 0) {
            rows.push({
                kind: 'result-hint',
                rowKey: `${sectionPlan.id}::resultHint`,
                sectionId: sectionPlan.id,
                hint: sectionPlan.resultHint,
            });
        }
    }
    return rows;
}

type SelectionListVirtualizedOptionPositions = Readonly<{ byId: ReadonlyMap<string, number>; setSize: number }>;

/**
 * The previous item for a row whose members are all unchanged (an `option-row`'s cells compared one by
 * one), otherwise the new one; the array itself when no row changed. Options are compared by identity:
 * a step that rebuilds an unchanged option keeps it (see `retainShallow`), and a new option redraws.
 */
const planItemKey = (item: SelectionListBodyVirtualizedItem) => item.rowKey;
const planItemType = (item: SelectionListBodyVirtualizedItem) => item.kind;
const sourceItemKey = (item: SelectionListVirtualizedOptionSourceItem) => item.key;
const sourceItemType = (item: SelectionListVirtualizedOptionSourceItem) => item.kind;

export function retainVirtualizedItems(
    previous: ReadonlyArray<SelectionListBodyVirtualizedItem> | undefined,
    next: ReadonlyArray<SelectionListBodyVirtualizedItem>,
): ReadonlyArray<SelectionListBodyVirtualizedItem> {
    if (!previous || previous === next) return next;
    const previousByKey = new Map<string, SelectionListBodyVirtualizedItem>();
    const previousCells = new Map<string, SelectionListBodyVirtualizedOptionItem>();
    for (const item of previous) {
        previousByKey.set(item.rowKey, item);
        if (item.kind === 'option-row') for (const cell of item.options) previousCells.set(cell.rowKey, cell);
    }
    let changed = previous.length !== next.length;
    const items = next.map((item, index) => {
        let candidate: SelectionListBodyVirtualizedItem = item;
        if (item.kind === 'option-row') {
            const cells = item.options.map(cell => retainShallow(previousCells.get(cell.rowKey), cell));
            const held = previousByKey.get(item.rowKey);
            const sameCells = held?.kind === 'option-row' && held.options.length === cells.length
                && cells.every((cell, cellIndex) => cell === held.options[cellIndex]);
            candidate = held?.kind === 'option-row' && sameCells && retainShallow(held, { ...item, options: held.options }) === held
                ? held
                : cells.every((cell, cellIndex) => cell === item.options[cellIndex]) ? item : { ...item, options: cells };
        } else {
            candidate = retainShallow(previousByKey.get(item.rowKey), item);
        }
        if (candidate !== previous[index]) changed = true;
        return candidate;
    });
    return changed ? items : previous;
}

/**
 * Fold consecutive option rows of ONE section into column blocks
 * (`chunkIntoColumnBlocks`).
 *
 * Headers, skeletons, error / not-found / empty-hint rows are deliberately
 * left alone: they are full-width by nature and span the pane for free.
 *
 * A section with fewer options than there are columns gets ONE column, so its
 * card spans the pane rather than sitting beside a blank spacer. The rule is
 * owned by `resolveSelectionListSectionColumnCount` so the mapped renderer,
 * this one, and the arrow geometry cannot disagree.
 *
 * Grouping decides WHAT a block is; it does not number the rows.
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
        for (const cells of chunkIntoColumnBlocks(pending, sectionColumnCount)) {
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
    registerCellLayout?: SelectionListRegisterScrollItemLayout | null;
    rootTestID: string | undefined;
    stepId: string;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
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
    // Highlight, selection and set position come from the body's row-state provider, not this cell.
    const optionRow = (
        <SelectionListVirtualizedOptionRow
            option={item.option}
            rootTestID={ctx.rootTestID}
            stepId={ctx.stepId}
            onSelect={ctx.onSelect}
            onPushStep={ctx.onPushStep}
            positionInSet={1}
            measureMode={ctx.measureMode === true}
            {...(cellPlacement === undefined ? {} : { cellPlacement })}
            {...(rowIndex === undefined ? {} : { rowIndex })}
        />
    );
    // A source's refresh state changes presentation, never the retained row's parent/identity.
    return <VirtualizedOptionCellFrame key={item.rowKey} stale={item.isStale === true}>{optionRow}</VirtualizedOptionCellFrame>;
}

/** The retained parent of a virtualized option. */
function VirtualizedOptionCellFrame(props: Readonly<{
    stale: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <View style={props.stale ? selectionListDynamicRowStyles.staleSection : undefined}>
            {props.children}
        </View>
    );
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
            <SelectionListScrollIntoViewContext.Provider value={ctx.registerCellLayout ?? null}>
                <SelectionListColumnRow
                    columnCount={item.columnCount}
                    columnGapPx={ctx.columnGapPx}
                    rowIndex={placement?.rowIndex}
                    optionRowIndex={placement?.optionRowIndex}
                >
                    {item.options.map((cell, cellIndex) => renderVirtualizedOptionCell(cell, ctx, {
                        columnIndex: (cellIndex % item.columnCount) + 1,
                        columnSpan: item.columnSpan,
                    }))}
                </SelectionListColumnRow>
            </SelectionListScrollIntoViewContext.Provider>
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
                    rightAccessory={renderSelectionListAccessory(item.rightAccessory)}
                    count={item.count}
                    action={measureMode ? undefined : item.action}
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
                retry={item.retry}
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
                loading={item.loading}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'emptyHint')}
            />
        ), ctx.a11yPattern);
    }

    if (item.kind === 'result-hint') {
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', item.sectionId);
        return renderFlatListboxSectionGroup((
            <SelectionListResultHintRow
                hint={item.hint}
                testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'resultHint')}
                measureMode={measureMode}
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
    selectedOptionIds: ReadonlySet<string>;
    focusedOptionId: string | null;
    focusedOptionIndex?: number;
    /**
     * The row the list keeps in view, decided once by `SelectionList` (keyboard, programmatic or
     * selection; never a pointer-focused row, which would slide away and snap every wheel scroll back).
     */
    scrollTargetOptionId?: string | null;
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
    /** `SelectionListProps.bodyHeader`, already wrapped by the body: scrolls with the rows. */
    bodyHeader?: React.ReactElement | null;
    /** `SelectionListProps.bodyFooter`, already wrapped by the body: scrolls with the rows. */
    bodyFooter?: React.ReactElement | null;
    /** The empty state shown between the slots when the plan has no rows. */
    emptyContent?: React.ReactElement | null;
    /** See `SelectionListBodyProps.virtualizedViewportHeight`. */
    viewportHeight?: number;
}>;

export function SelectionListBodyVirtualized(props: SelectionListBodyVirtualizedProps): React.ReactElement {
    if (props.virtualizedOptionSource) {
        return <SelectionListBodyDirectVirtualizedSource {...props} source={props.virtualizedOptionSource} />;
    }
    return <SelectionListBodyFlattenedVirtualized {...props} />;
}

function SelectionListPaneEdgeFades(props: Readonly<{ edges: React.ComponentProps<typeof ScrollEdgeFades>['edges'] }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <ScrollEdgeFades color={theme.colors.surface.base} size={theme.space.s16} edges={props.edges} />;
}

function SelectionListBodyFlattenedVirtualized(props: SelectionListBodyVirtualizedProps): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const columnCount = props.columnCount ?? 1;
    const columnGapPx = props.columnGapPx;
    // A rebuilt plan that leaves a row as it was keeps that row's item (and the positions every
    // cell reads), so the recycler redraws only the rows that changed.
    const publishedRef = React.useRef<Readonly<{
        items: ReadonlyArray<SelectionListBodyVirtualizedItem>;
        positions: SelectionListVirtualizedOptionPositions;
    }> | null>(null);
    const flatItems = React.useMemo(
        () => retainVirtualizedItems(publishedRef.current?.items, groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList(props.plan),
            columnCount,
        )),
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
            // A block's cells are in reading order, so reading order and set position agree.
            for (const cell of item.options) {
                position += 1;
                byId.set(cell.option.id, position);
            }
        }
        const previous = publishedRef.current?.positions;
        const positions = previous && previous.setSize === position && previous.byId.size === byId.size
            && [...byId].every(([id, at]) => previous.byId.get(id) === at) ? previous : { byId, setSize: position };
        publishedRef.current = { items: flatItems, positions };
        return positions;
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

    // RV-9: scroll-to-row across the flattened item list. Compute the flat-index of the row the list
    // keeps in view (the scroll target, not a pointer-focused row); ask virtualized list to centre it.
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const revealOptionId = props.scrollTargetOptionId ?? null;
    const revealItemIndex = React.useMemo(
        () => revealOptionId === null ? -1 : flatItems.findIndex((row) => {
            if (row.kind === 'option') return row.option.id === revealOptionId;
            // A revealed cell brings its block into view; `revealFocusedCell` then narrows to the cell.
            if (row.kind === 'option-row') {
                return row.options.some((cell) => cell.option.id === revealOptionId);
            }
            return false;
        }),
        [revealOptionId, flatItems],
    );
    const revealCell = revealOptionId === null ? undefined : (() => {
        const row = flatItems[revealItemIndex];
        return row?.kind === 'option-row' ? row.options.find((cell) => cell.option.id === revealOptionId) : undefined;
    })();
    const { onViewportLayout, registerCellLayout } = useSelectionListVirtualizedFocusReveal({
        listRef: virtualizedListRef,
        focusedItemIndex: revealItemIndex,
        focusedKey: revealOptionId,
        cellLayoutItems: flatItems,
        optionPositions: optionPositions.byId,
        focusedCellDomId: revealCell === undefined ? null : resolveSelectionListOptionDomId({
            option: revealCell.option,
            rootTestID: props.rootTestID,
            stepId: props.stepId,
        }),
        reducedMotion,
    });

    const measureMode = props.measureMode === true;
    // A pane that scrolls whole has no fixed band to clip its content against, so its edges fade instead.
    const paneFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 4,
    });
    const paneScrollsWhole = !measureMode && props.bodyHeader != null;
    const { onEndReached, footer: paginationFooter } = useSelectionListVirtualizedPagination({
        pagination: props.pagination,
        measureMode,
        rootTestID: props.rootTestID,
        a11yPattern,
    });
    // A host hands these per render (often inline); their identity is not a row fact, so it never
    // invalidates a recycled cell. Activation always reaches the newest callback.
    const onSelect = useEventCallback(props.onSelect);
    const onPushStep = useEventCallback(props.onPushStep);
    const renderItem = React.useCallback(
        ({ item }: { item: SelectionListBodyVirtualizedItem }) =>
            renderVirtualizedListRow(item, {
                registerCellLayout,
                rootTestID: props.rootTestID,
                stepId: props.stepId,
                onSelect,
                onPushStep,
                measureMode,
                columnCount,
                columnGapPx,
                a11yPattern,
                ...(gridRowModel === null ? {} : { gridRowModel }),
            }),
        [
            props.rootTestID,
            props.stepId,
            onSelect,
            onPushStep,
            registerCellLayout,
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
            style={[styles.body, styles.virtualizedHost, props.viewportHeight === undefined ? null : { height: props.viewportHeight }]}
            {...(measureMode || props.listboxAria === null
                ? {}
                : (props.listboxAria as unknown as Record<string, never>))}
            {...(hostAccessibilityHide ?? {})}
        >
            <SelectionListVirtualizedRowStateProvider
                selectedOptionIds={props.selectedOptionIds}
                focusedOptionId={props.focusedOptionId}
                optionPositionById={optionPositions.byId}
                optionSetSize={optionPositions.setSize}
            >
                <VirtualizedList
                    ref={virtualizedListRef}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(props.rootTestID, 'bodyVirtualizedList')}
                    data={flatItems as SelectionListBodyVirtualizedItem[]}
                    // Only row configuration invalidates cells; per-row facts arrive through the provider.
                    extraData={renderItem}
                    keyExtractor={planItemKey}
                    renderItem={renderItem}
                    getItemType={planItemType}
                    estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                    recycleItems={false}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                    onLayout={measureMode ? undefined : (event) => {
                        onViewportLayout(event);
                        if (paneScrollsWhole) paneFades.onViewportLayout(event);
                    }}
                    {...(paneScrollsWhole ? {
                        onContentSizeChange: paneFades.onContentSizeChange,
                        onScroll: paneFades.onScroll,
                        onMomentumScrollEnd: paneFades.onMomentumScrollEnd,
                        scrollEventThrottle: 16,
                    } : {})}
                    onEndReached={onEndReached}
                    onEndReachedThreshold={props.pagination ? 0.35 : undefined}
                    ListHeaderComponent={props.bodyHeader ?? undefined}
                    ListFooterComponent={props.bodyFooter
                        ? <>{paginationFooter}{props.bodyFooter}</>
                        : paginationFooter}
                    ListEmptyComponent={props.emptyContent ?? undefined}
                />
            </SelectionListVirtualizedRowStateProvider>
            {paneScrollsWhole ? (
                <SelectionListPaneEdgeFades edges={paneFades.visibility} />
            ) : null}
        </View>
    );
}

type DirectVirtualizedSourceRowContext = Readonly<{
    source: SelectionListVirtualizedOptionSource;
    rootTestID: string | undefined;
    stepId: string;
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
                    monoTitle={header.monoTitle}
                    count={header.count}
                    rightAccessory={renderSelectionListAccessory(header.rightAccessory)}
                />
            </View>
        );
    }

    if (item.kind === 'result-hint') {
        // The same coverage line as a planned section's hint ("Showing the first …", offline Files).
        const header = ctx.source.getHeader(item.sectionIndex);
        const sectionTestId = selectionListTestId(ctx.rootTestID, 'section', header.id);
        return renderFlatListboxSectionGroup((
            <SelectionListResultHintRow
                hint={header.resultHint ?? ''}
                testID={ctx.measureMode ? undefined : selectionListTestId(sectionTestId, 'resultHint')}
                measureMode={ctx.measureMode}
            />
        ), ctx.a11yPattern);
    }

    const option = ctx.source.getOption(item.optionIndex);
    return (
        <SelectionListVirtualizedOptionRow
            option={option}
            rootTestID={ctx.rootTestID}
            stepId={ctx.stepId}
            onSelect={ctx.onSelect}
            onPushStep={ctx.onPushStep}
            positionInSet={item.positionInSet}
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
    const onSelect = useEventCallback(props.onSelect);
    const onPushStep = useEventCallback(props.onPushStep);
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    // The row the list keeps in view; the focused row's known index avoids a source lookup.
    const revealOptionId = props.scrollTargetOptionId ?? null;
    const revealOptionIndex = revealOptionId === null
        ? -1
        : revealOptionId === props.focusedOptionId && props.focusedOptionIndex !== undefined
            ? props.focusedOptionIndex
            : source.findOptionIndexById(revealOptionId);
    const revealItemIndex = revealOptionIndex < 0 ? -1 : source.findItemIndexByOptionIndex(revealOptionIndex);
    const { onViewportLayout } = useSelectionListVirtualizedFocusReveal({
        listRef: virtualizedListRef,
        focusedItemIndex: revealItemIndex,
        focusedKey: revealOptionId,
        reducedMotion,
    });

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
            onSelect,
            onPushStep,
            measureMode,
            a11yPattern,
        }),
        [
            source,
            sourceStateKey,
            props.rootTestID,
            props.stepId,
            onSelect,
            onPushStep,
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
            style={[styles.body, styles.virtualizedHost, props.viewportHeight === undefined ? null : { height: props.viewportHeight }]}
            {...(measureMode || props.listboxAria === null
                ? {}
                : (props.listboxAria as unknown as Record<string, never>))}
            {...(hostAccessibilityHide ?? {})}
        >
            <SelectionListVirtualizedRowStateProvider
                selectedOptionIds={props.selectedOptionIds}
                focusedOptionId={props.focusedOptionId}
                optionSetSize={source.optionCount}
            >
                <VirtualizedList
                    ref={virtualizedListRef}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(props.rootTestID, 'bodyVirtualizedList')}
                    data={source.items}
                    // The row callback captures every non-item input except the per-row facts (source/stateKey,
                    // row configuration). Focus and selection arrive through the row-state provider instead.
                    extraData={renderItem}
                    keyExtractor={sourceItemKey}
                    renderItem={renderItem}
                    getItemType={sourceItemType}
                    estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                    recycleItems={false}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                    onLayout={measureMode ? undefined : onViewportLayout}
                    onEndReached={onEndReached}
                    onEndReachedThreshold={props.pagination ? 0.35 : undefined}
                    ListFooterComponent={paginationFooter}
                />
            </SelectionListVirtualizedRowStateProvider>
        </View>
    );
}
