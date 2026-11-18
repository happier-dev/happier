import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX } from './_constants';
import { SelectionListVirtualizedOptionRow, SelectionListVirtualizedRowStateProvider } from './SelectionListVirtualizedRowState';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import { selectionListTestId } from './_shared';
import {
    buildSelectionListSectionGroupA11yProps,
    type SelectionListA11yPattern,
} from './buildSelectionListOptionA11yProps';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
} from './_types';
import { useSelectionListVirtualizedFocusReveal } from './useSelectionListVirtualizedFocusReveal';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'column',
    },
    virtualizedHost: {
        // A four-row fallback for a caller that declares no bound (a declared
        // `maxHeight` replaces it, `viewportHeight`); a shorter parent (keyboard,
        // rotation, or compact modal viewport) remains authoritative.
        height: SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX * 4,
        maxHeight: '100%',
        minHeight: 0,
        flexShrink: 1,
        flexGrow: 1,
    },
}));

export type SelectionListVirtualizedSectionProps = Readonly<{
    section: SelectionListSection;
    /** Currently-active step id (used to namespace per-option testIDs). */
    stepId: string;
    /** Root testID prefix forwarded from the SelectionList orchestrator. */
    rootTestID?: string;
    /** The hidden measurement uses the same bounded viewport without live identities or focus. */
    measureMode?: boolean;
    selectedOptionIds: ReadonlySet<string>;
    /**
     * F4 — Currently focused option id (keyboard navigation). Mirrors the
     * non-virtualized path's focused-row visual state and triggers
     * scroll-to-focused-row inside the virtualized virtualized list host. When `null`
     * (no focus, e.g. caret in the input), the section neither paints a
     * focused row nor scrolls.
     */
    focusedOptionId?: string | null;
    /** The row the list keeps in view (`SelectionList` decides; never a pointer-focused row). */
    scrollTargetOptionId?: string | null;
    /**
     * Canonical row-activation sinks, forwarded verbatim to `PlanOptionRow`.
     * The row itself owns activation (`activateSelectionListRow`), so these are
     * the SAME callbacks the non-virtualized path receives — wrapping them in a
     * second activation helper here would commit twice.
     */
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById?: ReadonlyMap<string, number>;
    optionSetSize?: number;
    showsVerticalScrollIndicator?: boolean;
    /** See `SelectionListBodyProps.virtualizedViewportHeight`. */
    viewportHeight?: number;
    /** The body-owned popup pattern; only listbox sections become groups. */
    a11yPattern?: SelectionListA11yPattern;
    /**
     * `grid`-pattern row identity, from the body's shared row model. All three
     * are absent in `listbox` mode (and in a bare harness), where this section
     * emits no row indices and its header keeps the role-free markup.
     *
     * This path only ever runs at ONE column — a columned step with a
     * virtualized section is routed to the flat renderer, which is the only one
     * that understands columns — so `gridColumnCount` is here for the header's
     * `aria-colspan` to stay honest rather than to lay anything out.
     */
    gridColumnCount?: number;
    /** `aria-rowindex` of this section's header row, when it renders one. */
    headerRowIndex?: number;
    /** Grid rows preceding this section's first option row, header included. */
    rowIndexOffset?: number;
}>;

/**
 * Renders one virtualization-eligible SelectionList section through a
 * virtualized list. Eligibility (descriptor hint plus the
 * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD` row count) is decided once by the
 * body's virtualization policy and the dynamic-section renderer, which mounts
 * this component only for eligible sections; smaller sections render as
 * mapped rows there.
 */
export function SelectionListVirtualizedSection(
    props: SelectionListVirtualizedSectionProps,
): React.ReactElement {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();

    const sectionTestId = selectionListTestId(
        props.rootTestID,
        'section',
        props.section.id,
    );
    const measureMode = props.measureMode === true;
    const focusedOptionId = measureMode ? null : props.focusedOptionId ?? null;
    const sectionGroupA11y = measureMode || props.a11yPattern === undefined
        ? null
        : buildSelectionListSectionGroupA11yProps({
            pattern: props.a11yPattern,
            title: props.section.title,
        });

    // One row renderer for the whole primitive: virtualized rows render the
    // canonical `PlanOptionRow`, so custom `content`, both ellipsize modes,
    // chevron retention, the selected row's `expandedContent`, ARIA identity
    // and the scroll-into-view layout registration cannot drift between the
    // mapped and virtualized paths. Activation stays single-source: the row
    // calls `activateSelectionListRow` with the callbacks below.
    // At one column the option wrapper IS the grid row, so it needs the
    // popup-wide index — which counts this section's header row and every row
    // above it, and therefore is not the option's position in the set.
    const rowIndexOffset = props.rowIndexOffset;
    const { rootTestID, stepId, onSelect, onPushStep } = props;
    const options = props.section.options;
    // Focus, selection and set position reach rows through the row-state provider below, so the
    // cell renderer (the list's `extraData`) changes only with the row configuration and options.
    const renderRow = React.useCallback(
        (option: SelectionListOption): React.ReactElement => {
            const index = options.findIndex((candidate) => candidate.id === option.id);
            return (
                <SelectionListVirtualizedOptionRow
                    key={option.id}
                    option={option}
                    measureMode={measureMode}
                    rootTestID={rootTestID}
                    stepId={stepId}
                    onSelect={onSelect}
                    onPushStep={onPushStep}
                    positionInSet={index + 1}
                    nextOption={options[index + 1] ?? null}
                    {...(rowIndexOffset === undefined ? {} : { rowIndex: rowIndexOffset + index + 1 })}
                />
            );
        },
        [rootTestID, stepId, onSelect, onPushStep, options, rowIndexOffset, measureMode],
    );

    const headerTestId = selectionListTestId(sectionTestId, 'header');
    const headerGridRow = props.headerRowIndex === undefined
        ? undefined
        : { rowIndex: props.headerRowIndex, columnCount: props.gridColumnCount ?? 1 };

    // F4 — scroll-to-row. `SelectionList` decides the row the list keeps in view
    // (keyboard or programmatic focus, never the pointer); when it belongs to
    // THIS section, ask virtualized list to bring it into view centered
    // (`viewPosition: 0.5`). When it is null or lives in a different section,
    // do nothing — the other section's virtualized host (if any) owns its own
    // scroll behavior.
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const revealOptionId = measureMode ? null : props.scrollTargetOptionId ?? null;
    const revealItemIndex = React.useMemo(
        () => revealOptionId === null
            ? -1
            : props.section.options.findIndex((option) => option.id === revealOptionId),
        [revealOptionId, props.section.options],
    );
    const { onViewportLayout } = useSelectionListVirtualizedFocusReveal({
        listRef: virtualizedListRef,
        focusedItemIndex: revealItemIndex,
        focusedKey: revealOptionId,
        reducedMotion,
    });

    return (
        <View
            testID={measureMode ? undefined : sectionTestId}
            style={[styles.container, styles.virtualizedHost, props.viewportHeight === undefined ? null : { height: props.viewportHeight }]}
            {...(measureMode ? { accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants' as const, pointerEvents: 'none' as const,
                'aria-hidden': true } : {})}
            {...(sectionGroupA11y ?? {})}
            {...(sectionGroupA11y === null ? {} : { role: 'group' as const })}
        >
            <SelectionListSectionHeader
                testID={measureMode ? undefined : headerTestId}
                title={props.section.title}
                rightAccessory={renderSelectionListAccessory(props.section.rightAccessory)}
                count={props.section.count}
                action={measureMode ? undefined : props.section.action}
                {...(measureMode || headerGridRow === undefined ? {} : { gridRow: headerGridRow })}
            />
            <SelectionListVirtualizedRowStateProvider
                selectedOptionIds={props.selectedOptionIds}
                focusedOptionId={focusedOptionId}
                optionPositionById={props.optionPositionById}
                optionSetSize={props.optionSetSize ?? options.length}
            >
                <VirtualizedList
                    ref={virtualizedListRef}
                    testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'virtualized')}
                    data={props.section.options as SelectionListOption[]}
                    extraData={renderRow}
                    keyExtractor={(option: SelectionListOption) => option.id}
                    renderItem={({ item }: { item: SelectionListOption }) => renderRow(item)}
                    getItemType={(option: SelectionListOption) => (option.openStep ? 'drilldown' : 'option')}
                    estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                    recycleItems={false}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                    onLayout={measureMode ? undefined : onViewportLayout}
                />
            </SelectionListVirtualizedRowStateProvider>
        </View>
    );
}
