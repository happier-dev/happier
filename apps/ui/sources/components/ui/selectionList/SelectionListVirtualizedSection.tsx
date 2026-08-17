import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
    SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX,
} from './_constants';
import { PlanOptionRow } from './SelectionListOptionRow';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { selectionListTestId } from './_shared';
import {
    buildSelectionListSectionGroupA11yProps,
    type SelectionListA11yPattern,
} from './buildSelectionListOptionA11yProps';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
    SelectionListVirtualizationMode,
} from './_types';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'column',
    },
    virtualizedHost: {
        // virtualized list needs a measurable host. The caller (`SelectionList`) is
        // expected to constrain the popover via `maxHeight`; this minHeight
        // ensures virtualized list has a non-zero default when nothing else is set.
        minHeight: SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX * 4,
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
    selectedOptionId: string | null;
    /**
     * F4 — Currently focused option id (keyboard navigation). Mirrors the
     * non-virtualized path's focused-row visual state and triggers
     * scroll-to-focused-row inside the virtualized virtualized list host. When `null`
     * (no focus, e.g. caret in the input), the section neither paints a
     * focused row nor scrolls.
     */
    focusedOptionId?: string | null;
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
    /**
     * Override the descriptor's virtualization hint. Prop wins; descriptor
     * falls back when undefined; if both are undefined the default `'auto'`
     * applies.
     */
    virtualization?: SelectionListVirtualizationMode;
    showsVerticalScrollIndicator?: boolean;
    /** The body-owned popup pattern; only listbox sections become groups. */
    a11yPattern?: SelectionListA11yPattern;
    /**
     * Override the threshold (test/escape hatch). Defaults to
     * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD`.
     */
    threshold?: number;
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

function resolveVirtualizationMode(
    propValue: SelectionListVirtualizationMode | undefined,
    sectionValue: SelectionListVirtualizationMode | undefined,
): SelectionListVirtualizationMode {
    if (propValue !== undefined) return propValue;
    if (sectionValue !== undefined) return sectionValue;
    return 'auto';
}

function shouldVirtualize(
    mode: SelectionListVirtualizationMode,
    rowCount: number,
    threshold: number,
): boolean {
    if (mode === 'force') return true;
    if (mode === 'never') return false;
    return rowCount > threshold;
}

/**
 * Renders a single SelectionList section, switching between a plain
 * `ItemGroup` + mapped `Item` rows path and a virtualized `virtualized list` path
 * based on the descriptor's `virtualization` hint and row count.
 *
 * Threshold (default 50) is owned by `_constants.ts` per the plan's
 * Phase 0.5 decision. Threshold is overridable for tests/escape hatches but
 * production consumers should rely on the default.
 *
 * Why a wrapper (rather than always using virtualized list): per the React Native
 * skill and Phase 0.5 audit, virtualized list carries non-trivial setup cost and
 * requires a measurable parent; below the threshold the simpler mapped path
 * is the right default and avoids virtualization side-effects (recycler
 * focus juggling, intermittent layout thrash) for small lists where they
 * are not needed.
 */
export function SelectionListVirtualizedSection(
    props: SelectionListVirtualizedSectionProps,
): React.ReactElement {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const mode = resolveVirtualizationMode(props.virtualization, props.section.virtualization);
    const threshold = props.threshold ?? SELECTION_LIST_VIRTUALIZATION_THRESHOLD;
    const rowCount = props.section.options.length;
    const useVirtualization = shouldVirtualize(mode, rowCount, threshold);

    const sectionTestId = selectionListTestId(
        props.rootTestID,
        'section',
        props.section.id,
    );
    const sectionGroupA11y = props.a11yPattern === undefined
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
    const renderRow = React.useCallback(
        (option: SelectionListOption): React.ReactElement => (
            <PlanOptionRow
                key={option.id}
                option={option}
                rootTestID={props.rootTestID}
                stepId={props.stepId}
                isSelected={props.selectedOptionId === option.id}
                // F4 — focus parity: keep keyboard focus visual state separate
                // from the row's selected accessibility state, matching the
                // plain mapped path.
                isFocused={props.focusedOptionId != null && props.focusedOptionId === option.id}
                onSelect={props.onSelect}
                onPushStep={props.onPushStep}
                positionInSet={props.optionPositionById?.get(option.id)
                    ?? props.section.options.findIndex((candidate) => candidate.id === option.id) + 1}
                setSize={props.optionSetSize ?? props.section.options.length}
                {...(rowIndexOffset === undefined ? {} : {
                    rowIndex: rowIndexOffset
                        + props.section.options.findIndex((candidate) => candidate.id === option.id)
                        + 1,
                })}
            />
        ),
        [props, rowIndexOffset],
    );

    const headerTestId = selectionListTestId(sectionTestId, 'header');
    const headerGridRow = props.headerRowIndex === undefined
        ? undefined
        : { rowIndex: props.headerRowIndex, columnCount: props.gridColumnCount ?? 1 };

    // F4 — scroll-to-focused-row. Keyboard navigation updates
    // `focusedOptionId` at the orchestrator; when the focused row belongs to
    // THIS section, ask virtualized list to bring it into view centered
    // (`viewPosition: 0.5`). When the focused option is null or lives in a
    // different section, do nothing — the other section's virtualized host
    // (if any) owns its own scroll behavior.
    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const focusedOptionId = props.focusedOptionId ?? null;
    React.useEffect(() => {
        if (focusedOptionId === null) return;
        const ref = virtualizedListRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        const index = props.section.options.findIndex((opt) => opt.id === focusedOptionId);
        if (index < 0) return;
        ref.scrollToIndex({ index, viewPosition: 0.5, animated: !reducedMotion });
    }, [focusedOptionId, props.section.options, reducedMotion]);

    if (useVirtualization) {
        return (
            <View
                testID={sectionTestId}
                style={[styles.container, styles.virtualizedHost]}
                {...(sectionGroupA11y ?? {})}
                {...(sectionGroupA11y === null ? {} : { role: 'group' as const })}
            >
                <SelectionListSectionHeader
                    testID={headerTestId}
                    title={props.section.title}
                    count={props.section.count}
                    {...(headerGridRow === undefined ? {} : { gridRow: headerGridRow })}
                />
                <VirtualizedList
                    ref={virtualizedListRef}
                    testID={selectionListTestId(sectionTestId, 'virtualized')}
                    data={props.section.options as SelectionListOption[]}
                    keyExtractor={(option: SelectionListOption) => option.id}
                    renderItem={({ item }: { item: SelectionListOption }) => renderRow(item)}
                    getItemType={(option: SelectionListOption) => (option.openStep ? 'drilldown' : 'option')}
                    estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                    recycleItems={false}
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                />
            </View>
        );
    }

    return (
        <View
            testID={sectionTestId}
            style={styles.container}
            {...(sectionGroupA11y ?? {})}
            {...(sectionGroupA11y === null ? {} : { role: 'group' as const })}
        >
            <SelectionListSectionHeader
                testID={headerTestId}
                title={props.section.title}
                count={props.section.count}
                    {...(headerGridRow === undefined ? {} : { gridRow: headerGridRow })}
            />
            {props.section.options.map((option) => renderRow(option))}
        </View>
    );
}
