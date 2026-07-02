/**
 * FR4-W2-BODY — single-FlashList flat rendering path extracted from
 * `SelectionListBody.tsx`.
 *
 * RV-9 / FRESH-3 — when 2+ sections are virtualization-eligible (or a single
 * eligible section is in a stale dynamic state), the body collapses ALL
 * sections (headers + option rows + dynamic-state rows) into one flat
 * FlashList. This avoids the legacy nested FlashList-in-ScrollView anti-
 * pattern and keeps trailing sections fully scrollable.
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    FlashList,
    type FlashListRef,
} from '@/components/ui/lists/flashListCompat/FlashListCompat';
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
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import {
    collectVirtualizationEligibleSectionIds,
    maybeWarnAboutMultipleVirtualizedSections,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type { SelectionListOption, SelectionListStep } from './_types';

type ListboxAriaProps = Readonly<{ id: string; role: 'listbox' }>;

const styles = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
    virtualizedHost: {
        // RV-9: ensure the flat FlashList has a measurable host. Mirrors
        // `SelectionListVirtualizedSection.virtualizedHost`.
        minHeight: 56 * 4,
    },
    sectionWrap: {
        flexDirection: 'column',
    },
}));

/**
 * RV-9 / FRESH-3 — Flat-row representation of the render plan consumed by
 * the single-FlashList multi-section body path. Each row is a discriminated
 * union so FlashList's `getItemType(item)` can pool recycled views by type.
 *
 * The selection / focus state is intentionally NOT embedded in the flat
 * items: the body's `renderItem` closure reads it from the latest props,
 * keeping items value-stable across keyboard navigation and avoiding
 * recycler churn.
 */
export type SelectionListBodyFlashListItem =
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
 * single-FlashList path. The flattening mirrors the per-section branching
 * in `renderSectionElement` (loading, error, notFound, empty, success) but
 * emits one flat row per visible element so FlashList recycles them
 * uniformly across sections.
 */
export function flattenRenderPlanForFlashList(
    plan: ReadonlyArray<SectionRenderPlan>,
): ReadonlyArray<SelectionListBodyFlashListItem> {
    const rows: SelectionListBodyFlashListItem[] = [];
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
    /** FR3-1 / FR3-8 — identity-free measure rendering. */
    measureMode?: boolean;
}>;

function renderFlatFlashListRow(
    item: SelectionListBodyFlashListItem,
    ctx: FlatRowRenderContext,
): React.ReactElement | null {
    const dynStyles = selectionListDynamicRowStyles;
    const measureMode = ctx.measureMode === true;

    if (item.kind === 'option') {
        const isSelected = ctx.selectedOptionId === item.option.id;
        const isFocused = ctx.focusedOptionId !== null && ctx.focusedOptionId === item.option.id;
        return (
            <PlanOptionRow
                option={item.option}
                rootTestID={ctx.rootTestID}
                stepId={ctx.stepId}
                isSelected={isSelected}
                isFocused={isFocused}
                onSelect={ctx.onSelect}
                onPushStep={ctx.onPushStep}
                measureMode={measureMode}
            />
        );
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
 * RV-9 / FRESH-3 — Single FlashList rendering ALL sections (headers +
 * option rows + dynamic-state rows) as a flat list. Used when 2+ sections
 * are virtualization-eligible. Avoids the legacy nested FlashList-in-
 * ScrollView anti-pattern and keeps trailing sections fully scrollable.
 */
export function SelectionListBodyFlatFlashList(props: Readonly<{
    rootTestID: string | undefined;
    listboxAria: ListboxAriaProps | null;
    plan: ReadonlyArray<SectionRenderPlan>;
    stepId: string;
    selectedOptionId: string | null;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    showsVerticalScrollIndicator?: boolean;
    /** FR3-1 / FR3-8 — identity-free measure mode. */
    measureMode?: boolean;
}>): React.ReactElement {
    const flatItems = React.useMemo(
        () => flattenRenderPlanForFlashList(props.plan),
        [props.plan],
    );

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
    // the flat-index of the focused option; ask FlashList to bring it into
    // view centered.
    const flashListRef = React.useRef<FlashListRef<SelectionListBodyFlashListItem> | null>(null);
    const focusedOptionId = props.focusedOptionId;
    React.useEffect(() => {
        if (focusedOptionId === null) return;
        const ref = flashListRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        const index = flatItems.findIndex(
            (row) => row.kind === 'option' && row.option.id === focusedOptionId,
        );
        if (index < 0) return;
        ref.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    }, [focusedOptionId, flatItems]);

    const measureMode = props.measureMode === true;
    const renderItem = React.useCallback(
        ({ item }: { item: SelectionListBodyFlashListItem }) =>
            renderFlatFlashListRow(item, {
                rootTestID: props.rootTestID,
                stepId: props.stepId,
                selectedOptionId: props.selectedOptionId,
                focusedOptionId: props.focusedOptionId,
                onSelect: props.onSelect,
                onPushStep: props.onPushStep,
                measureMode,
            }),
        [
            props.rootTestID,
            props.stepId,
            props.selectedOptionId,
            props.focusedOptionId,
            props.onSelect,
            props.onPushStep,
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
            <FlashList
                ref={flashListRef as unknown as React.Ref<FlashListRef<SelectionListBodyFlashListItem>>}
                testID={measureMode
                    ? undefined
                    : selectionListTestId(props.rootTestID, 'bodyFlashList')}
                data={flatItems as SelectionListBodyFlashListItem[]}
                keyExtractor={(item: SelectionListBodyFlashListItem) => item.rowKey}
                renderItem={renderItem}
                getItemType={(item: SelectionListBodyFlashListItem) => item.kind}
                estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            />
        </View>
    );
}
