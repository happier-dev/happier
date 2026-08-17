/**
 * R14 — `SelectionListBody` extraction. Renders the current step's body
 * (sections + options) inside the cross-slide frame. The body intentionally
 * does not host the search header or the footer — those are persistent across
 * step transitions and live in Zones 1 and 3 of the three-zone composition
 * (see plan §Phase 1.9).
 *
 * FR4-W2-BODY — split into focused sub-modules:
 *  - `SelectionListBodyScrollFrame`        — outer ScrollView + edge fades
 *  - `SelectionListOptionRow`              — option row + animated transitions
 *  - `SelectionListDynamicSectionRows`     — skeleton/error/notFound/emptyHint
 *                                            rows + per-section composition
 *  - `SelectionListVirtualizedBody`          — flat single virtualized list path + flattening
 *  - `selectionListVirtualizationPolicy`   — eligibility decisions + dev warning
 *
 * This file is the body's composition shell. It decides between three
 * rendering paths based on virtualization policy:
 *   - 0 eligible sections → ScrollView with edge fades
 *   - any eligible section with neighboring sections, or stale-eligible →
 *     single flat virtualized list
 *   - exactly 1 eligible (non-stale) → per-section `SelectionListVirtualizedSection`
 *
 * That choice is LATCHED for the lifetime of a step and only ever escalates
 * toward the more capable renderer. Every input above is transient — an option
 * count that crosses the threshold as the user filters, a section count that
 * drops when a filter empties a section, a `dynamicState` that flips on refetch
 * — and a transient value may not decide WHICH component renders the body. See
 * `advanceSelectionListBodyRendererLatch`.
 *
 * R9 (blocker 1): when the body contains only non-virtualized sections, wrap
 * the section list in a ScrollView so the user can scroll past the popover's
 * `maxHeight` cap. The popover surface (`AgentInputSelectionListPopover`)
 * intentionally sets `scrollEnabled={false}` because SelectionList owns its
 * own scroll. Without this wrapper, lists below the virtualization threshold
 * (up to 50 rows) clip silently when their natural height exceeds maxHeight.
 *
 * Skipped when ANY section is virtualized — virtualized list provides its own
 * scrollable host and a wrapping ScrollView would steal gestures.
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    buildSelectionListContainerA11yProps,
    buildSelectionListSectionGroupA11yProps,
    type SelectionListA11yPattern,
    type SelectionListContainerA11yProps,
} from './buildSelectionListOptionA11yProps';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { buildSelectionListGridRowModel } from './selectionListGridRowModel';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import {
    flattenRenderPlanForVirtualizedList,
    groupVirtualizedItemsIntoColumnRows,
    SelectionListBodyVirtualized,
} from './SelectionListVirtualizedBody';
import { SelectionListBodyScrollFrame } from './SelectionListBodyScrollFrame';
import {
    renderSelectionListSectionNodes,
    type SelectionListSectionRenderContext,
} from './SelectionListDynamicSectionRows';
import { SelectionListEmptyState } from './SelectionListEmptyState';
import {
    advanceSelectionListBodyRendererLatch,
    applyLatchedVirtualizationToPlan,
    resolveVirtualizedSectionIds,
    type SelectionListBodyRendererLatch,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListOptionPresentation,
    SelectionListPagination,
    SelectionListStep,
    SelectionListVirtualizedOptionSource,
} from './_types';

// FR4-W2-BODY — re-export the public API so existing import paths
// (`from './SelectionListBody'`) remain stable. The implementations now live
// in the focused sub-modules listed above.
export {
    planHasVirtualizedSection,
    planRequiresFlatVirtualizedList,
    resolveVirtualizedSectionIds,
    resetSelectionListMultiVirtualizationWarningCache,
} from './selectionListVirtualizationPolicy';
export {
    flattenRenderPlanForVirtualizedList,
    type SelectionListBodyVirtualizedItem,
} from './SelectionListVirtualizedBody';

const stylesheet = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
}));

export type SelectionListBodyProps = Readonly<{
    step: SelectionListStep;
    rootTestID: string | undefined;
    selectedOptionId: string | null | undefined;
    plan: ReadonlyArray<SectionRenderPlan>;
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource;
    focusedOptionId: string | null;
    /** Source-local focused option position for a direct virtualized source. */
    focusedOptionIndex?: number;
    scrollTargetOptionId?: string | null;
    listboxId: string;
    accessibilityLabel?: string;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    showsVerticalScrollIndicator?: boolean;
    pagination?: SelectionListPagination;
    /**
     * FR3-1 / FR3-8 — when `'measure'`, the body is rendered as an
     * identity-free mirror used by `SelectionListAnimatedHeight` for height
     * measurement. In measure mode every host-element id / testID / role /
     * accessibility prop is suppressed so the live DOM never contains
     * duplicate listbox ids, duplicate option ids, or duplicate aria-labels.
     * The visual LAYOUT is preserved verbatim — height measurement requires
     * the natural layout to remain identical to the visible tree.
     *
     * Defaults to `'normal'`.
     */
    mode?: 'measure' | 'normal';
    /**
     * Lane G — resolved visual columns per row. `1` (or omitted) renders the
     * classic one-option-per-row list. Resolved ONCE by the orchestrator and
     * passed to both the live body and the measure mirror so the mirror never
     * reports a height for a different layout than the one on screen.
     */
    columnCount?: number;
    /**
     * Gutter between adjacent columns, forwarded from `columns.columnGapPx`.
     * Without this the resolver could size columns against a caller's gutter
     * while the rows painted the shared default one, making every column
     * narrower than the minimum the caller declared.
     */
    columnGapPx?: number;
    /**
     * Whether the CALLER DECLARED a `columns` config — not whether the measured
     * width currently resolves more than one of them.
     *
     * This is what picks the virtualized renderer, and it has to be a
     * declaration for the same reason `a11yPattern` does: `columnCount` moves
     * with the container's measured width, so keying the choice on it made a
     * MEASUREMENT decide WHICH COMPONENT rendered the body. Crossing the column
     * breakpoint then unmounted the whole body subtree and mounted the other
     * renderer in its place — the visible "the list rebuilt itself" jiggle, with
     * scroll position, focus and every row's identity destroyed by it. Layout
     * may change within a renderer; it may not change which renderer runs.
     *
     * Defaults to `false` for a body rendered directly by a harness, which
     * keeps every list that declares no columns on the renderer it has always
     * had.
     */
    declaresColumns?: boolean;
    /**
     * Visual presentation for option rows, resolved ONCE by the orchestrator
     * and published to every row path (see
     * `SelectionListOptionPresentationContext`). Passed to both the live body
     * and the measure mirror so the mirror never reports a height for a
     * different presentation than the one on screen.
     */
    optionPresentation?: SelectionListOptionPresentation;
    /**
     * The popup's ARIA pattern, resolved by the orchestrator from the caller's
     * DECLARED capabilities (`columns`, `optionsHostInlineControls`) and passed
     * to both the live body and the measure mirror.
     *
     * A prop rather than a local derivation: the combobox input advertises the
     * same value through `aria-haspopup`, and two derivations of one composite
     * widget's pattern are two things that can disagree. Nothing the body can
     * see — the plan, the selection, the resolved column count — is allowed to
     * be an input, because all of them move while the popup is open.
     *
     * Defaults to `'listbox'` for a body rendered directly by a harness.
     */
    a11yPattern?: SelectionListA11yPattern;
}>;

export function SelectionListBody(props: SelectionListBodyProps): React.ReactElement {
    // One decision, one publisher. The container role, the row role, and the
    // cell role have to agree for the composite widget to be valid, so the
    // pattern is published to every row path from here instead of being
    // re-derived per row.
    const pattern = props.a11yPattern ?? 'listbox';
    return (
        <SelectionListA11yPatternContext.Provider value={pattern}>
            <SelectionListOptionPresentationContext.Provider value={props.optionPresentation ?? 'row'}>
                <SelectionListBodyContent {...props} />
            </SelectionListOptionPresentationContext.Provider>
        </SelectionListA11yPatternContext.Provider>
    );
}

/**
 * Holds the body's latched renderer choice across renders.
 *
 * Resolved DURING render rather than in an effect: the renderer is needed by
 * the very render that observes the plan, and an effect would paint one frame
 * with the un-latched choice — which is the swap this exists to prevent. The
 * advance is idempotent (escalate-only, union-only), so re-running it on the
 * same plan is a no-op and a double-invoked render cannot move it.
 */
function useLatchedBodyRenderer(
    args: Parameters<typeof advanceSelectionListBodyRendererLatch>[1],
): SelectionListBodyRendererLatch {
    const latchRef = React.useRef<SelectionListBodyRendererLatch | null>(null);
    const latch = advanceSelectionListBodyRendererLatch(latchRef.current, args);
    latchRef.current = latch;
    return latch;
}

function SelectionListBodyContent(props: SelectionListBodyProps): React.ReactElement {
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    if (props.virtualizedOptionSource) {
        return (
            <SelectionListBodyDirectVirtualizedSource
                {...props}
                a11yPattern={a11yPattern}
            />
        );
    }
    return <SelectionListBodyPlannedContent {...props} a11yPattern={a11yPattern} />;
}

function SelectionListBodyPlannedContent(props: SelectionListBodyProps & Readonly<{
    a11yPattern: SelectionListA11yPattern;
}>): React.ReactElement {
    const styles = stylesheet;
    const plan = props.plan;
    const isMeasure = props.mode === 'measure';
    const a11yPattern = props.a11yPattern;
    const optionPositions = React.useMemo(() => {
        const byId = new Map<string, number>();
        let position = 0;
        for (const section of plan) {
            for (const option of section.options) {
                position += 1;
                byId.set(option.id, position);
            }
        }
        return { byId, setSize: position };
    }, [plan]);
    const columnCount = props.columnCount ?? 1;
    // The grid's ROW model. `aria-rowcount` and `aria-rowindex` must describe
    // VISUAL rows — the thing a screen-reader user is told they are moving
    // through — which means the painted grid rows: one per section header, and
    // one per option (single column) or per group of options (columned). They
    // counted options while a row could only ever hold one option and a header
    // was not a row; both of those stopped being true.
    //
    // Derived from the flattener + grouper the virtualized path already runs,
    // so every renderer numbers its rows from the same sequence. The mapped
    // renderer consumes the per-section offsets below; the flat one looks up
    // each item's index by row key.
    const gridRowModel = React.useMemo(() => {
        if (a11yPattern !== 'grid') return null;
        return buildSelectionListGridRowModel(groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList(plan),
            columnCount,
        ));
    }, [a11yPattern, plan, columnCount]);
    // FR3-1 / FR3-8 — in measure mode every identity / accessibility prop on
    // host elements the body owns is suppressed so the hidden measure mirror
    // never duplicates listbox / option ids in the live DOM. We still render
    // identical layout (same components, same heights) so the measure host
    // reports the correct natural height.
    //
    // `aria-rowcount` and `aria-colcount` ARE plan- and layout-derived, and
    // that is correct: they are counts of what is currently in the grid, the
    // grid equivalent of `aria-setsize` on a filtered listbox. A count that
    // tracks the filter is truthful; a ROLE SET that tracks the filter is the
    // defect this corridor exists to fix, and the pattern above is now settled
    // before any of these numbers are known.
    const listboxAria: SelectionListContainerA11yProps | null = isMeasure
        ? null
        : buildSelectionListContainerA11yProps({
            containerId: props.listboxId,
            pattern: a11yPattern,
            rowCount: gridRowModel?.rowCount ?? optionPositions.setSize,
            columnCount,
            accessibilityLabel: props.accessibilityLabel,
        });
    const bodyTestId = isMeasure
        ? undefined
        : selectionListTestId(props.rootTestID, 'body');
    const bodyHostAccessibilityHide = isMeasure
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
            pointerEvents: 'none' as const,
            'aria-hidden': true,
        }
        : null;
    // RV-9: branch the body on virtualization-eligibility.
    //   - 0 eligible → ScrollView path (small lists scroll past maxHeight)
    //   - 1 eligible and no neighboring sections →
    //     SelectionListVirtualizedSection (one virtualized list owns the body)
    //   - eligible with neighbors → single flat virtualized list covering the body
    //     (avoids competing section/body scroll owners)
    //
    // Lane G: the flat path is the ONLY virtualized renderer that understands
    // columns. Routing a columned step there rather than teaching
    // `SelectionListVirtualizedSection` about grids too keeps one owner for
    // the visual-row grouping instead of two that must agree — and that intent
    // is exactly why the DECLARATION, not the resolved count, is the input: a
    // pane that declares columns has one owner for its visual rows at every
    // width, including the widths where it currently resolves to one. Grouping
    // is a no-op at one column (`groupVirtualizedItemsIntoColumnRows` returns
    // the same array reference), so the single-column pane renders the plain
    // flat rows rather than a degenerate grid.
    //
    // Lane A: the eligibility itself is LATCHED per step. Read straight off the
    // current plan it is a transient value — an option count that crosses the
    // threshold as the user types, a section count that drops when a filter
    // empties a section, a `dynamicState` that flips on refetch — and it was
    // choosing which component rendered the body, so filtering a long list
    // unmounted the whole body and mounted a different renderer in its place,
    // once per keystroke around the boundary. See
    // `advanceSelectionListBodyRendererLatch` for the escalation-only ladder
    // and why a list that GROWS past the threshold still ends up virtualized.
    const latch = useLatchedBodyRenderer({
        stepId: props.step.id,
        plan,
        declaresPagination: props.pagination !== undefined,
        declaresColumns: props.declaresColumns === true,
    });

    if (plan.length === 0 && props.pagination === undefined) {
        const emptyStateGroupA11y = isMeasure
            ? null
            : buildSelectionListSectionGroupA11yProps({ pattern: a11yPattern });
        return (
            <View
                testID={bodyTestId}
                style={styles.body}
                {...(listboxAria === null
                    ? {}
                    : (listboxAria as unknown as Record<string, never>))}
                {...(bodyHostAccessibilityHide ?? {})}
            >
                {isMeasure ? null : emptyStateGroupA11y === null ? (
                    <SelectionListEmptyState
                        label={props.step.emptyStateLabel}
                        testID={selectionListTestId(props.rootTestID, 'empty')}
                    />
                ) : (
                    <View role="group" {...emptyStateGroupA11y}>
                        <SelectionListEmptyState
                            label={props.step.emptyStateLabel}
                            testID={selectionListTestId(props.rootTestID, 'empty')}
                        />
                    </View>
                )}
            </View>
        );
    }

    if (latch.renderer === 'flatVirtualized') {
        return (
            <SelectionListBodyVirtualized
                rootTestID={props.rootTestID}
                listboxAria={listboxAria}
                plan={plan}
                stepId={props.step.id}
                selectedOptionId={props.selectedOptionId ?? null}
                focusedOptionId={props.focusedOptionId}
                onSelect={props.onSelect}
                onPushStep={props.onPushStep}
                measureMode={isMeasure}
                columnCount={columnCount}
                columnGapPx={props.columnGapPx}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                pagination={props.pagination}
            />
        );
    }

    // Single-virtualized OR zero-virtualized → existing per-section path.
    //
    // The per-section renderers re-derive the threshold from each section's
    // CURRENT option count, so the latched decision is published into the plan
    // they read (see `applyLatchedVirtualizationToPlan`); otherwise a filtered
    // section would swap `SelectionListVirtualizedSection` for mapped rows one
    // level below the body — the same tear-down, one layer down.
    const latchedPlan = applyLatchedVirtualizationToPlan(plan, latch.virtualizedSectionIds);
    const virtualizedSectionIds = resolveVirtualizedSectionIds(latchedPlan);
    const sectionRenderCtx: SelectionListSectionRenderContext = {
        rootTestID: props.rootTestID,
        stepId: props.step.id,
        selectedOptionId: props.selectedOptionId,
        focusedOptionId: props.focusedOptionId,
        onSelect: props.onSelect,
        onPushStep: props.onPushStep,
        optionPositionById: optionPositions.byId,
        optionSetSize: optionPositions.setSize,
        measureMode: isMeasure,
        a11yPattern,
        columnCount,
        columnGapPx: props.columnGapPx,
        optionRowOffsetBySectionId: gridRowModel?.optionRowOffsetBySectionId,
        headerRowIndexBySectionId: gridRowModel?.headerRowIndexBySectionId,
        showsVerticalScrollIndicator: props.showsVerticalScrollIndicator === true,
    };
    const sectionNodes = renderSelectionListSectionNodes(
        latchedPlan,
        virtualizedSectionIds,
        sectionRenderCtx,
    );

    if (latch.renderer === 'scrollFrame') {
        if (isMeasure) {
            // In measure mode skip the BodyScrollWithEdgeFades wrapper entirely
            // — its testIDs and listbox role are identity props and the
            // edge-fade overlays are visual-only (would not affect the natural
            // measured height). Render the section nodes directly inside an
            // identity-free shell that mirrors the visible body's flex layout.
            return (
                <View style={styles.body} {...(bodyHostAccessibilityHide ?? {})}>
                    {sectionNodes}
                </View>
            );
        }
        return (
            <SelectionListBodyScrollFrame
                bodyTestId={selectionListTestId(props.rootTestID, 'body')}
                scrollTestId={selectionListTestId(props.rootTestID, 'bodyScroll')}
                fadeHostTestId={selectionListTestId(props.rootTestID, 'bodyScroll', 'fadeHost')}
                fadeTopTestId={selectionListTestId(props.rootTestID, 'bodyScroll', 'fadeTop')}
                fadeBottomTestId={selectionListTestId(props.rootTestID, 'bodyScroll', 'fadeBottom')}
                listboxAria={listboxAria as SelectionListContainerA11yProps}
                scrollTargetOptionId={props.scrollTargetOptionId ?? null}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            >
                {sectionNodes}
            </SelectionListBodyScrollFrame>
        );
    }

    return (
        <View
            testID={bodyTestId}
            style={styles.body}
            {...(listboxAria === null
                ? {}
                : (listboxAria as unknown as Record<string, never>))}
            {...(bodyHostAccessibilityHide ?? {})}
        >
            {sectionNodes}
        </View>
    );
}

function SelectionListBodyDirectVirtualizedSource(props: SelectionListBodyProps & Readonly<{
    a11yPattern: SelectionListA11yPattern;
}>): React.ReactElement {
    const source = props.virtualizedOptionSource;
    if (!source) {
        throw new Error('SelectionList direct virtualized source is required');
    }
    const isMeasure = props.mode === 'measure';
    const listboxAria: SelectionListContainerA11yProps | null = isMeasure
        ? null
        : buildSelectionListContainerA11yProps({
            containerId: props.listboxId,
            pattern: props.a11yPattern,
            rowCount: source.optionCount,
            columnCount: 1,
            accessibilityLabel: props.accessibilityLabel,
        });
    const bodyTestId = isMeasure
        ? undefined
        : selectionListTestId(props.rootTestID, 'body');
    const bodyHostAccessibilityHide = isMeasure
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
            pointerEvents: 'none' as const,
            'aria-hidden': true,
        }
        : null;

    if (source.optionCount === 0 && props.pagination === undefined) {
        const emptyStateGroupA11y = isMeasure
            ? null
            : buildSelectionListSectionGroupA11yProps({ pattern: props.a11yPattern });
        return (
            <View
                testID={bodyTestId}
                style={stylesheet.body}
                {...(listboxAria === null
                    ? {}
                    : (listboxAria as unknown as Record<string, never>))}
                {...(bodyHostAccessibilityHide ?? {})}
            >
                {isMeasure ? null : emptyStateGroupA11y === null ? (
                    <SelectionListEmptyState
                        label={props.step.emptyStateLabel}
                        testID={selectionListTestId(props.rootTestID, 'empty')}
                    />
                ) : (
                    <View role="group" {...emptyStateGroupA11y}>
                        <SelectionListEmptyState
                            label={props.step.emptyStateLabel}
                            testID={selectionListTestId(props.rootTestID, 'empty')}
                        />
                    </View>
                )}
            </View>
        );
    }

    return (
        <SelectionListBodyVirtualized
            rootTestID={props.rootTestID}
            listboxAria={listboxAria}
            plan={props.plan}
            virtualizedOptionSource={source}
            stepId={props.step.id}
            selectedOptionId={props.selectedOptionId ?? null}
            focusedOptionId={props.focusedOptionId}
            focusedOptionIndex={props.focusedOptionIndex}
            onSelect={props.onSelect}
            onPushStep={props.onPushStep}
            measureMode={isMeasure}
            showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            pagination={props.pagination}
        />
    );
}
