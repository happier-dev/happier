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
 *  - `SelectionListFlatFlashList`          — flat single-FlashList path + flattening
 *  - `selectionListVirtualizationPolicy`   — eligibility decisions + dev warning
 *
 * This file is the body's composition shell. It decides between three
 * rendering paths based on virtualization policy:
 *   - 0 eligible sections → ScrollView with edge fades
 *   - ≥2 eligible OR stale-eligible → single flat FlashList
 *   - exactly 1 eligible (non-stale) → per-section `SelectionListVirtualizedSection`
 *
 * R9 (blocker 1): when the body contains only non-virtualized sections, wrap
 * the section list in a ScrollView so the user can scroll past the popover's
 * `maxHeight` cap. The popover surface (`AgentInputSelectionListPopover`)
 * intentionally sets `scrollEnabled={false}` because SelectionList owns its
 * own scroll. Without this wrapper, lists below the virtualization threshold
 * (up to 50 rows) clip silently when their natural height exceeds maxHeight.
 *
 * Skipped when ANY section is virtualized — FlashList provides its own
 * scrollable host and a wrapping ScrollView would steal gestures.
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionListBodyFlatFlashList } from './SelectionListFlatFlashList';
import { SelectionListBodyScrollFrame } from './SelectionListBodyScrollFrame';
import {
    renderSelectionListSectionNodes,
    type SelectionListSectionRenderContext,
} from './SelectionListDynamicSectionRows';
import { SelectionListEmptyState } from './SelectionListEmptyState';
import {
    planHasMultipleVirtualizedSections,
    planHasVirtualizedSection,
    resolveVirtualizedSectionIds,
} from './selectionListVirtualizationPolicy';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListStep,
} from './_types';

// FR4-W2-BODY — re-export the public API so existing import paths
// (`from './SelectionListBody'`) remain stable. The implementations now live
// in the focused sub-modules listed above.
export {
    planHasVirtualizedSection,
    planHasMultipleVirtualizedSections,
    resolveVirtualizedSectionIds,
    resetSelectionListMultiVirtualizationWarningCache,
} from './selectionListVirtualizationPolicy';
export {
    flattenRenderPlanForFlashList,
    type SelectionListBodyFlashListItem,
} from './SelectionListFlatFlashList';

const stylesheet = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
}));

type ListboxAriaProps = Readonly<{ id: string; role: 'listbox' }>;

export type SelectionListBodyProps = Readonly<{
    step: SelectionListStep;
    rootTestID: string | undefined;
    selectedOptionId: string | null | undefined;
    plan: ReadonlyArray<SectionRenderPlan>;
    focusedOptionId: string | null;
    scrollTargetOptionId?: string | null;
    listboxId: string;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    showsVerticalScrollIndicator?: boolean;
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
}>;

export function SelectionListBody(props: SelectionListBodyProps): React.ReactElement {
    const styles = stylesheet;
    const plan = props.plan;
    const isMeasure = props.mode === 'measure';
    // FR3-1 / FR3-8 — in measure mode every identity / accessibility prop on
    // host elements the body owns is suppressed so the hidden measure mirror
    // never duplicates listbox / option ids in the live DOM. We still render
    // identical layout (same components, same heights) so the measure host
    // reports the correct natural height.
    const listboxAria: ListboxAriaProps | null = isMeasure
        ? null
        : { id: props.listboxId, role: 'listbox' };
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
    //   - 1 eligible → SelectionListVirtualizedSection (existing path; one
    //     FlashList owns the scroll)
    //   - ≥2 eligible → single flat FlashList covering the entire body
    //     (avoids the nested FlashList-in-ScrollView anti-pattern)
    const ownsScrollViaFlashList = planHasVirtualizedSection(plan);
    const useFlatFlashListPath = planHasMultipleVirtualizedSections(plan);

    if (plan.length === 0) {
        return (
            <View
                testID={bodyTestId}
                style={styles.body}
                {...(listboxAria === null
                    ? {}
                    : (listboxAria as unknown as Record<string, never>))}
                {...(bodyHostAccessibilityHide ?? {})}
            >
                {isMeasure ? null : (
                    <SelectionListEmptyState
                        label={props.step.emptyStateLabel}
                        testID={selectionListTestId(props.rootTestID, 'empty')}
                    />
                )}
            </View>
        );
    }

    if (useFlatFlashListPath) {
        return (
            <SelectionListBodyFlatFlashList
                rootTestID={props.rootTestID}
                listboxAria={listboxAria}
                plan={plan}
                stepId={props.step.id}
                selectedOptionId={props.selectedOptionId ?? null}
                focusedOptionId={props.focusedOptionId}
                onSelect={props.onSelect}
                onPushStep={props.onPushStep}
                measureMode={isMeasure}
                showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            />
        );
    }

    // Single-virtualized OR zero-virtualized → existing per-section path.
    const virtualizedSectionIds = resolveVirtualizedSectionIds(plan);
    const sectionRenderCtx: SelectionListSectionRenderContext = {
        rootTestID: props.rootTestID,
        stepId: props.step.id,
        selectedOptionId: props.selectedOptionId,
        focusedOptionId: props.focusedOptionId,
        onSelect: props.onSelect,
        onPushStep: props.onPushStep,
        measureMode: isMeasure,
        showsVerticalScrollIndicator: props.showsVerticalScrollIndicator === true,
    };
    const sectionNodes = renderSelectionListSectionNodes(
        plan,
        virtualizedSectionIds,
        sectionRenderCtx,
    );

    if (!ownsScrollViaFlashList) {
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
                listboxAria={listboxAria as ListboxAriaProps}
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
