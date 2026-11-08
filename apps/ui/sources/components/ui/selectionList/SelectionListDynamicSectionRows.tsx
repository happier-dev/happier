/**
 * FR4-W2-BODY — dynamic-state row rendering extracted from
 * `SelectionListBody.tsx`. Single source of truth for skeleton / error /
 * not-found / empty-hint row visuals + a11y, shared between:
 *
 *  - the per-section path (`renderSectionElement` in SelectionListBody.tsx),
 *    which composes section header + dynamic rows + optional stale option
 *    rows inside one wrapping `View`; and
 *  - the flat virtualized list path (`SelectionListVirtualizedBody.tsx`), which emits
 *    each dynamic row as a standalone virtualized list row (no shared section
 *    wrapper).
 *
 * Style + opacity (stale wrapper) and constants are owned by this module so
 * both call sites stay visually identical without leaking the body's
 * stylesheet across files.
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import type { IconName } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { t } from '@/text';

import {
    SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS,
    SELECTION_LIST_SKELETON_ROW_SHAPE,
    SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
} from './_constants';
import {
    buildSelectionListSectionGroupA11yProps,
    type SelectionListA11yPattern,
} from './buildSelectionListOptionA11yProps';
import {
    PlanAnimatedSuccessRows,
    PlanSuccessRows,
    VirtualizedTransitionShell,
} from './SelectionListOptionRow';
import type { SelectionListGridRowPlacement } from './selectionListGridRowModel';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SelectionListVirtualizedSection } from './SelectionListVirtualizedSection';
import { SelectionListScrollOffsetFrame } from './SelectionListScrollOffsetFrame';
import { selectionListTestId } from './_shared';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
    SelectionListVirtualizationMode,
} from './_types';

export const SELECTION_LIST_STALE_OPTIONS_OPACITY = 0.6;

const dynamicRowStyles = StyleSheet.create(() => ({
    staleSection: {
        opacity: SELECTION_LIST_STALE_OPTIONS_OPACITY,
    },
}));

/** Re-export the stylesheet so the body composition (per-section path) can
 * reuse the exact same style objects for stale wrapping. */
export const selectionListDynamicRowStyles = dynamicRowStyles;

/**
 * Loading skeleton row — used by both the flat virtualized list path (one row per
 * skeleton) and the per-section path (rendered inside a single accessibility
 * container).
 */
export function SelectionListLoadingSkeletonRow(props: Readonly<{
    index: number;
    /** When provided, used as the row's testID; otherwise no testID is set. */
    testID: string | undefined;
}>): React.ReactElement {
    return (
        <SkeletonRows
            rows={1}
            firstIndex={props.index}
            {...SELECTION_LIST_SKELETON_ROW_SHAPE}
            {...(props.testID === undefined ? {} : { rowTestID: props.testID })}
        />
    );
}

/**
 * Container for one or more skeleton rows. Mirrors the per-section renderer
 * which wraps the array of skeletons in a single `accessibilityHidden` View
 * so AT only announces the visible (stale) rows.
 */
export function SelectionListLoadingSkeletonGroup(props: Readonly<{
    count: number;
    sectionTestId: string;
    measureMode: boolean;
    /** When provided, used to compose per-row testIDs. */
    rowTestIdBase: (i: number) => string | undefined;
    /** Outer container testID (the `:loading` namespace). */
    containerTestId: string | undefined;
}>): React.ReactElement {
    const a11yHide = props.measureMode
        ? {}
        : ({ accessibilityHidden: true, 'aria-hidden': true } as Record<string, unknown>);
    return (
        <View testID={props.containerTestId} {...a11yHide}>
            <SkeletonRows rows={props.count} {...SELECTION_LIST_SKELETON_ROW_SHAPE} rowTestID={props.rowTestIdBase} />
        </View>
    );
}

/**
 * A section's state lines (failed, not found, empty, still loading, result coverage) are the app's one
 * in-list line (`EmptyState layout="line"`): one quiet sentence on the rows' edge. A failed group says so
 * in that line with the warning glyph (Find lab ST "one line, no red"), never a filled band that reads as a
 * selected row. The caller decides whether the live-region aria spread renders (full rendering) or not
 * (measure-mode mirror).
 */
export function SelectionListStateLine(props: Readonly<{
    label: string;
    testID: string | undefined;
    aria?: Record<string, unknown>;
    loading?: boolean;
    iconName?: IconName;
    /** A quiet inline link after the sentence (a failed group's Retry). */
    retry?: Readonly<{ label: string; onPress: () => void }>;
}>): React.ReactElement | null {
    // A menu insets its rows from the surface edge; its lines take the same inset so they stay on the rows' edge.
    const inMenu = React.useContext(SelectionListOptionPresentationContext) === 'menu';
    // A line with nothing to say (a step that declares an empty label) takes no space.
    if (props.label === '' && !props.loading && props.iconName === undefined) return null;
    const line = (
        <EmptyState
            layout="line"
            testID={props.testID}
            title={props.label}
            lineLoading={props.loading}
            lineDensity={inMenu ? 'menu' : undefined}
            iconName={props.iconName}
            primaryAction={props.retry ? {
                label: props.retry.label,
                onPress: props.retry.onPress,
                testID: props.testID ? `${props.testID}:retry` : undefined,
            } : undefined}
        />
    );
    if (props.aria === undefined && !inMenu) return line;
    return <View {...props.aria} style={inMenu ? dynamicRowStyles.menuLine : undefined}>{line}</View>;
}

/** Error row — `role="alert"` unless rendered as the identity-free measure mirror. */
export function SelectionListErrorRow(props: Readonly<{
    label: string;
    testID: string | undefined;
    measureMode: boolean;
    retry?: Readonly<{ label: string; onPress: () => void }>;
}>): React.ReactElement {
    return (
        <SelectionListStateLine
            label={props.label}
            testID={props.testID}
            iconName="warning"
            retry={props.retry}
            aria={props.measureMode ? undefined : { role: 'alert', 'aria-live': 'polite' }}
        />
    );
}

/** Not-found row (resolver verdict): `role="status"` so AT announces the path-resolution result. */
export function SelectionListNotFoundRow(props: Readonly<{
    label: string;
    testID: string | undefined;
    measureMode: boolean;
}>): React.ReactElement {
    return (
        <SelectionListStateLine
            label={props.label}
            testID={props.testID}
            aria={props.measureMode ? undefined : { role: 'status', 'aria-live': 'polite' }}
        />
    );
}

/**
 * Empty-hint row — descriptor-provided "no matches" message, or the line a section that names its first
 * load shows while it loads (`loading`). No role/aria-live announcement.
 */
export function SelectionListEmptyHintRow(props: Readonly<{
    hint: string;
    testID: string | undefined;
    loading?: boolean;
}>): React.ReactElement {
    return <SelectionListStateLine label={props.hint} testID={props.testID} loading={props.loading} />;
}

/** Visible result-coverage hint; SelectionList's canonical status region announces it. */
export function SelectionListResultHintRow(props: Readonly<{
    hint: string;
    testID: string | undefined;
    measureMode: boolean;
}>): React.ReactElement {
    return <SelectionListStateLine label={props.hint} testID={props.testID} />;
}

const sectionWrapStyles = StyleSheet.create(() => ({
    sectionWrap: {
        flexDirection: 'column',
    },
    virtualizedSectionWrap: {
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
}));

/**
 * Per-section render context. Plumbed through the body composition so the
 * dynamic-section renderer doesn't need to know about the body's full prop
 * surface (no leaky `SelectionListBodyProps` coupling).
 */
export type SelectionListSectionRenderContext = Readonly<{
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionIds: ReadonlySet<string>;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById: ReadonlyMap<string, number>;
    optionSetSize: number;
    showsVerticalScrollIndicator: boolean;
    /** See `SelectionListBodyProps.virtualizedViewportHeight`. */
    virtualizedViewportHeight?: number;
    /** FR3-1 / FR3-8 — identity-free measure rendering. */
    measureMode: boolean;
    /** The body-owned popup pattern, shared with every section renderer. */
    a11yPattern: SelectionListA11yPattern;
    /** Lane G — resolved column count for the `columns` variant. `1` = classic rows. */
    columnCount?: number;
    /** Gutter between adjacent columns. Defaults to the shared list gutter. */
    columnGapPx?: number;
    /**
     * Rows preceding each section's first option row — the section's own header
     * row included in the `aria-rowindex` half — so a section can number its
     * own rows into the popup-wide sequences. Present at EVERY column count in
     * `grid` mode; absent in `listbox` mode, which emits no row indices.
     */
    optionRowOffsetBySectionId?: ReadonlyMap<string, SelectionListGridRowPlacement>;
    /**
     * `aria-rowindex` of each section's header row. A header that renders text
     * cannot be a role-less child of a grid, so in `grid` mode it becomes a row
     * of its own — see `buildSelectionListSectionHeaderGridA11yProps`.
     */
    headerRowIndexBySectionId?: ReadonlyMap<string, number>;
}>;

/**
 * Render the section nodes from the plan. Extracted so the body can decide
 * whether to wrap them in a ScrollView (non-virtualized) or render them flat
 * (virtualized — virtualized list owns the scroll container).
 */
export function renderSelectionListSectionNodes(
    plan: ReadonlyArray<SectionRenderPlan>,
    virtualizedSectionIds: ReadonlySet<string>,
    ctx: SelectionListSectionRenderContext,
): ReadonlyArray<React.ReactNode> {
    return plan.map((sectionPlan) =>
        renderSelectionListSectionElement(
            sectionPlan,
            virtualizedSectionIds.has(sectionPlan.id),
            ctx,
        ),
    );
}

/**
 * Render a single section. Branches on `dynamicState` to emit
 * loading/error/empty/success variants and on virtualization to choose
 * between the virtualized virtualized list path and the plain mapped path.
 *
 * R16c (Major 5): the body-level resolver decides whether THIS section is
 * allowed to virtualize. The descriptor's own virtualization hint is the
 * upstream signal; the resolver downgrades extra virtualized-eligible
 * sections to plain rendering and emits a dev warning. `allowVirtualization`
 * is the per-section verdict from the resolver.
 */
function renderSelectionListSectionElement(
    sectionPlan: SectionRenderPlan,
    allowVirtualization: boolean,
    ctx: SelectionListSectionRenderContext,
): React.ReactElement | null {
    const wrapStyles = sectionWrapStyles;
    const dynStyles = dynamicRowStyles;
    const { measureMode } = ctx;
    const sectionTestId = selectionListTestId(
        ctx.rootTestID,
        'section',
        sectionPlan.id,
    );
    const headerTestId = selectionListTestId(sectionTestId, 'header');
    // Last-known rows being refreshed keep their ink; only rows a failed refresh left behind are dimmed.
    const wrapperStyle = sectionPlan.isStale === true && sectionPlan.dynamicState === 'error'
        ? [wrapStyles.sectionWrap, dynStyles.staleSection]
        : wrapStyles.sectionWrap;
    const sectionGroupA11y = measureMode
        ? null
        : buildSelectionListSectionGroupA11yProps({
            pattern: ctx.a11yPattern,
            title: sectionPlan.title,
        });
    const sectionGroupFrameProps = sectionGroupA11y === null
        ? {}
        : {
            role: 'group' as const,
            ariaProps: sectionGroupA11y,
        };
    // The measure mirror stays identity-free: no testIDs, no roles, no row
    // indices — only the layout, which one extra role-carrying wrapper around
    // the header does not change.
    const headerRowIndex = measureMode
        ? undefined
        : ctx.headerRowIndexBySectionId?.get(sectionPlan.id);
    const header = (
        <SelectionListSectionHeader
            testID={measureMode ? undefined : headerTestId}
            title={sectionPlan.title}
            rightAccessory={renderSelectionListAccessory(sectionPlan.rightAccessory)}
            count={sectionPlan.count}
            action={measureMode ? undefined : sectionPlan.action}
            {...(headerRowIndex === undefined
                ? {}
                : { gridRow: { rowIndex: headerRowIndex, columnCount: ctx.columnCount ?? 1 } })}
        />
    );
    const sectionTestIdForRender = measureMode ? undefined : sectionTestId;

    if (sectionPlan.dynamicState === 'loading') {
        const skeletonCount = sectionPlan.skeletonRowCount ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS;
        return (
            <SelectionListScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
                {...sectionGroupFrameProps}
            >
                {header}
                {skeletonCount === 0 && sectionPlan.hint && sectionPlan.isStale !== true ? (
                    <SelectionListEmptyHintRow
                        hint={sectionPlan.hint}
                        loading
                        testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'loading', 'hint')}
                    />
                ) : null}
                <SelectionListLoadingSkeletonGroup
                    count={skeletonCount}
                    sectionTestId={sectionTestId}
                    measureMode={measureMode}
                    containerTestId={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'loading')}
                    rowTestIdBase={(i) => measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'loading', `row-${i}`)}
                />
                {sectionPlan.isStale === true && sectionPlan.options.length > 0 ? (
                    <PlanSuccessRows
                        plan={sectionPlan}
                        rootTestID={ctx.rootTestID}
                        stepId={ctx.stepId}
                        selectedOptionIds={ctx.selectedOptionIds}
                        focusedOptionId={ctx.focusedOptionId}
                        onSelect={ctx.onSelect}
                        onPushStep={ctx.onPushStep}
                        optionPositionById={ctx.optionPositionById}
                        optionSetSize={ctx.optionSetSize}
                        measureMode={measureMode}
                        columnCount={ctx.columnCount}
                        columnGapPx={ctx.columnGapPx}
                        rowOffset={ctx.optionRowOffsetBySectionId?.get(sectionPlan.id)}
                    />
                ) : null}
            </SelectionListScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'error') {
        const errorLabel = sectionPlan.hint ?? t('selectionList.dynamicSectionError');
        return (
            <SelectionListScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
                {...sectionGroupFrameProps}
            >
                {header}
                <SelectionListErrorRow
                    label={errorLabel}
                    testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'error')}
                    measureMode={measureMode}
                    retry={sectionPlan.retry}
                />
                {sectionPlan.options.length > 0 ? (
                    <View style={dynStyles.staleSection}>
                        <PlanSuccessRows
                            plan={sectionPlan}
                            rootTestID={ctx.rootTestID}
                            stepId={ctx.stepId}
                            selectedOptionIds={ctx.selectedOptionIds}
                            focusedOptionId={ctx.focusedOptionId}
                            onSelect={ctx.onSelect}
                            onPushStep={ctx.onPushStep}
                            optionPositionById={ctx.optionPositionById}
                            optionSetSize={ctx.optionSetSize}
                            measureMode={measureMode}
                            columnCount={ctx.columnCount}
                            columnGapPx={ctx.columnGapPx}
                            rowOffset={ctx.optionRowOffsetBySectionId?.get(sectionPlan.id)}
                        />
                    </View>
                ) : null}
            </SelectionListScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'notFound') {
        const notFoundLabel = sectionPlan.hint ?? t('selectionList.pathNotFound');
        return (
            <SelectionListScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
                {...sectionGroupFrameProps}
            >
                {header}
                <SelectionListNotFoundRow
                    label={notFoundLabel}
                    testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'notFound')}
                    measureMode={measureMode}
                />
            </SelectionListScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'empty') {
        if (sectionPlan.hint === undefined || sectionPlan.hint.length === 0) {
            return null;
        }
        return (
            <SelectionListScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
                {...sectionGroupFrameProps}
            >
                {header}
                <SelectionListEmptyHintRow
                    hint={sectionPlan.hint}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'emptyHint')}
                />
            </SelectionListScrollOffsetFrame>
        );
    }

    // Success — render via the virtualized helper when its row count crosses
    // the virtualization threshold (or is forced); otherwise plain map.
    const sectionForRender: SelectionListSection = {
        id: sectionPlan.id,
        title: sectionPlan.title,
        rightAccessory: sectionPlan.rightAccessory,
        count: sectionPlan.count,
        action: sectionPlan.action,
        options: sectionPlan.options,
        virtualization: sectionPlan.virtualization,
    };
    const mode: SelectionListVirtualizationMode =
        sectionPlan.virtualization ?? 'auto';
    const eligibleForVirtualization =
        mode === 'force'
        || (
            mode === 'auto'
            && sectionPlan.options.length > SELECTION_LIST_VIRTUALIZATION_THRESHOLD
        );
    // R16c (Major 5): the body-level resolver may downgrade additional
    // virtualization-eligible sections to plain rendering when a step
    // declares more than one. `allowVirtualization` is false for those.
    const willVirtualize = eligibleForVirtualization && allowVirtualization;

    if (willVirtualize && !measureMode) {
        const virtualizedNode = (
            <SelectionListVirtualizedSection
                section={sectionForRender}
                stepId={ctx.stepId}
                rootTestID={ctx.rootTestID}
                selectedOptionIds={ctx.selectedOptionIds}
                // F4 — thread the keyboard-driven focused option through
                // so the virtualized renderer can mirror focused styling
                // AND so it can scroll the focused row into view
                // (matching the plain mapped path's UX).
                focusedOptionId={ctx.focusedOptionId}
                // The virtualized rows are `PlanOptionRow`s: they own
                // activation themselves, so the raw sinks are forwarded
                // (wrapping them in `activateSelectionListRow` here would
                // commit twice).
                onSelect={ctx.onSelect}
                onPushStep={ctx.onPushStep}
                optionPositionById={ctx.optionPositionById}
                optionSetSize={ctx.optionSetSize}
                showsVerticalScrollIndicator={ctx.showsVerticalScrollIndicator}
                viewportHeight={ctx.virtualizedViewportHeight}
                a11yPattern={ctx.a11yPattern}
                gridColumnCount={ctx.columnCount ?? 1}
                headerRowIndex={headerRowIndex}
                rowIndexOffset={ctx.optionRowOffsetBySectionId?.get(sectionPlan.id)?.rowIndex}
            />
        );
        // FR3-9: when the virtualized section advertises a `transitionKey`
        // (dynamic directory drill seed), wrap it in the same
        // `SlideTransitionSwitch` that `PlanAnimatedSuccessRows` uses on the
        // mapped row path so directory drill-downs cross-slide instead of
        // snapping when the row count crosses the virtualization threshold.
        const virtualizedTransitionKey = typeof sectionPlan.transitionKey === 'string'
            && sectionPlan.transitionKey.length > 0
            ? sectionPlan.transitionKey
            : undefined;
        if (virtualizedTransitionKey !== undefined) {
            return (
                <View
                    key={sectionPlan.id}
                    style={[wrapperStyle, wrapStyles.virtualizedSectionWrap]}
                >
                    <VirtualizedTransitionShell
                        transitionKey={virtualizedTransitionKey}
                        sectionTestId={sectionTestId}
                    >
                        {virtualizedNode}
                    </VirtualizedTransitionShell>
                    {sectionPlan.resultHint ? (
                        <SelectionListResultHintRow
                            hint={sectionPlan.resultHint}
                            testID={selectionListTestId(sectionTestId, 'resultHint')}
                            measureMode={false}
                        />
                    ) : null}
                </View>
            );
        }
        return (
            <View
                key={sectionPlan.id}
                style={[wrapperStyle, wrapStyles.virtualizedSectionWrap]}
            >
                {virtualizedNode}
                {sectionPlan.resultHint ? (
                    <SelectionListResultHintRow
                        hint={sectionPlan.resultHint}
                        testID={selectionListTestId(sectionTestId, 'resultHint')}
                        measureMode={false}
                    />
                ) : null}
            </View>
        );
    }

    // RUX-1 Issue 8: when the dynamic section advertises a `transitionKey`
    // (the resolver seed), wrap the success rows in a SlideTransitionSwitch
    // so directory drill-downs cross-slide instead of snapping. Static
    // sections never set transitionKey, so they render plainly.
    const useAnimatedRows = typeof sectionPlan.transitionKey === 'string'
        && sectionPlan.transitionKey.length > 0;

    return (
        <SelectionListScrollOffsetFrame
            key={sectionPlan.id}
            testID={sectionTestIdForRender}
            style={wrapperStyle}
            {...sectionGroupFrameProps}
        >
            {header}
            {useAnimatedRows && !measureMode ? (
                <PlanAnimatedSuccessRows
                    plan={sectionPlan}
                    rootTestID={ctx.rootTestID}
                    stepId={ctx.stepId}
                    selectedOptionIds={ctx.selectedOptionIds}
                    focusedOptionId={ctx.focusedOptionId}
                    onSelect={ctx.onSelect}
                    onPushStep={ctx.onPushStep}
                    optionPositionById={ctx.optionPositionById}
                    optionSetSize={ctx.optionSetSize}
                    columnCount={ctx.columnCount}
                    columnGapPx={ctx.columnGapPx}
                    rowOffset={ctx.optionRowOffsetBySectionId?.get(sectionPlan.id)}
                    transitionKey={sectionPlan.transitionKey as string}
                    sectionTestId={sectionTestId}
                />
            ) : (
                <PlanSuccessRows
                    plan={sectionPlan}
                    rootTestID={ctx.rootTestID}
                    stepId={ctx.stepId}
                    selectedOptionIds={ctx.selectedOptionIds}
                    focusedOptionId={ctx.focusedOptionId}
                    onSelect={ctx.onSelect}
                    onPushStep={ctx.onPushStep}
                    optionPositionById={ctx.optionPositionById}
                    optionSetSize={ctx.optionSetSize}
                    measureMode={measureMode}
                    columnCount={ctx.columnCount}
                    columnGapPx={ctx.columnGapPx}
                    rowOffset={ctx.optionRowOffsetBySectionId?.get(sectionPlan.id)}
                />
            )}
            {sectionPlan.resultHint ? (
                <SelectionListResultHintRow
                    hint={sectionPlan.resultHint}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'resultHint')}
                    measureMode={measureMode}
                />
            ) : null}
        </SelectionListScrollOffsetFrame>
    );
}
