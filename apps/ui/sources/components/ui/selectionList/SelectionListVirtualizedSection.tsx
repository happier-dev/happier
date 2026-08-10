import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { FlashList, type FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';

import {
    SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
    SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX,
} from './_constants';
import { buildSelectionListOptionA11yProps } from './buildSelectionListOptionA11yProps';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { selectionListTestId } from './_shared';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListVirtualizationMode,
} from './_types';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'column',
    },
    virtualizedHost: {
        // FlashList needs a measurable host. The caller (`SelectionList`) is
        // expected to constrain the popover via `maxHeight`; this minHeight
        // ensures FlashList has a non-zero default when nothing else is set.
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
     * scroll-to-focused-row inside the virtualized FlashList host. When `null`
     * (no focus, e.g. caret in the input), the section neither paints a
     * focused row nor scrolls.
     */
    focusedOptionId?: string | null;
    onSelectOption: (option: SelectionListOption) => void;
    /**
     * Override the descriptor's virtualization hint. Prop wins; descriptor
     * falls back when undefined; if both are undefined the default `'auto'`
     * applies.
     */
    virtualization?: SelectionListVirtualizationMode;
    showsVerticalScrollIndicator?: boolean;
    /**
     * Override the threshold (test/escape hatch). Defaults to
     * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD`.
     */
    threshold?: number;
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
 * `ItemGroup` + mapped `Item` rows path and a virtualized `FlashList` path
 * based on the descriptor's `virtualization` hint and row count.
 *
 * Threshold (default 50) is owned by `_constants.ts` per the plan's
 * Phase 0.5 decision. Threshold is overridable for tests/escape hatches but
 * production consumers should rely on the default.
 *
 * Why a wrapper (rather than always using FlashList): per the React Native
 * skill and Phase 0.5 audit, FlashList carries non-trivial setup cost and
 * requires a measurable parent; below the threshold the simpler mapped path
 * is the right default and avoids virtualization side-effects (recycler
 * focus juggling, intermittent layout thrash) for small lists where they
 * are not needed.
 */
export function SelectionListVirtualizedSection(
    props: SelectionListVirtualizedSectionProps,
): React.ReactElement {
    const styles = stylesheet;
    const mode = resolveVirtualizationMode(props.virtualization, props.section.virtualization);
    const threshold = props.threshold ?? SELECTION_LIST_VIRTUALIZATION_THRESHOLD;
    const rowCount = props.section.options.length;
    const useVirtualization = shouldVirtualize(mode, rowCount, threshold);

    const sectionTestId = selectionListTestId(
        props.rootTestID,
        'section',
        props.section.id,
    );

    const renderRow = React.useCallback(
        (option: SelectionListOption): React.ReactElement => {
            const optionTestId = selectionListTestId(
                props.rootTestID,
                props.stepId,
                'option',
                option.id,
            );
            const optionWrapperTestId = selectionListTestId(
                props.rootTestID,
                props.stepId,
                'option-wrapper',
                option.id,
            );
            const isSelected = props.selectedOptionId === option.id;
            // F4 — focus parity: mirror PlanOptionRow's
            // `selected={isSelected || isFocused}` so the keyboard-driven
            // focused row paints the same focused/selected visual state on
            // the virtualized path as on the plain mapped path.
            const isFocused = props.focusedOptionId != null
                && props.focusedOptionId === option.id;
            // F2 — single activation source: do NOT call `option.onSelect`
            // here. The orchestrator's `onSelectOption` (which delegates to
            // `activateSelectionListRow`) is the canonical entry point and is
            // responsible for invoking `option.onSelect` exactly once. Calling
            // it here as well produces a double-commit on virtualized rows
            // (e.g. directories with > 50 entries in PathSelectionList).
            const handlePress = () => {
                if (option.disabled) return;
                props.onSelectOption(option);
            };
            // R9 (blocker 4): mirror the plain (non-virtualized) path's ARIA
            // semantics so the input header's `aria-activedescendant` resolves
            // to a real element with role="option" + matching `id`. FlashList
            // recycles rows out of order, so wrappers are keyed by the option
            // id and apply per-render rather than via a memoised tree.
            const optionAria = buildSelectionListOptionA11yProps({
                optionTestId,
                isSelected,
                accessibilityLabel: option.accessibilityLabel,
            });
            const row = (
                <Item
                    testID={optionTestId}
                    title={option.label}
                    subtitle={option.subtitle}
                    icon={option.icon}
                    rightElement={renderSelectionListAccessory(option.rightAccessory)}
                    onPress={handlePress}
                    selected={isSelected || isFocused}
                    disabled={option.disabled === true}
                    loading={option.loading === true}
                    showChevron={Boolean(option.openStep)}
                    // On web the wrapper claims `role="option"`; the inner
                    // Item's default `accessibilityRole='button'` would shadow
                    // that, so we explicitly opt out via Item's `webRole`
                    // escape hatch (only affects web).
                    webRole="presentation"
                />
            );
            return (
                <View
                    key={option.id}
                    testID={optionWrapperTestId}
                    {...(optionAria as unknown as Record<string, never>)}
                >
                    {typeof option.testID === 'string' && option.testID.length > 0 ? (
                        <View testID={option.testID}>{row}</View>
                    ) : row}
                </View>
            );
        },
        [props],
    );

    const headerTestId = selectionListTestId(sectionTestId, 'header');

    // F4 — scroll-to-focused-row. Keyboard navigation updates
    // `focusedOptionId` at the orchestrator; when the focused row belongs to
    // THIS section, ask FlashList to bring it into view centered
    // (`viewPosition: 0.5`). When the focused option is null or lives in a
    // different section, do nothing — the other section's virtualized host
    // (if any) owns its own scroll behavior.
    const flashListRef = React.useRef<FlashListRef<SelectionListOption> | null>(null);
    const focusedOptionId = props.focusedOptionId ?? null;
    React.useEffect(() => {
        if (focusedOptionId === null) return;
        const ref = flashListRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        const index = props.section.options.findIndex((opt) => opt.id === focusedOptionId);
        if (index < 0) return;
        ref.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    }, [focusedOptionId, props.section.options]);

    if (useVirtualization) {
        return (
            <View testID={sectionTestId} style={[styles.container, styles.virtualizedHost]}>
                <SelectionListSectionHeader
                    testID={headerTestId}
                    title={props.section.title}
                    count={props.section.count}
                    rightAccessory={props.section.headerRightAccessory}
                />
                <FlashList
                    ref={flashListRef as unknown as React.Ref<FlashListRef<SelectionListOption>>}
                    testID={selectionListTestId(sectionTestId, 'virtualized')}
                    data={props.section.options as SelectionListOption[]}
                    keyExtractor={(option: SelectionListOption) => option.id}
                    renderItem={({ item }: { item: SelectionListOption }) => renderRow(item)}
                    getItemType={(option: SelectionListOption) => (option.openStep ? 'drilldown' : 'option')}
                    estimatedItemSize={SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX}
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
                />
            </View>
        );
    }

    return (
        <View testID={sectionTestId} style={styles.container}>
            <SelectionListSectionHeader
                testID={headerTestId}
                title={props.section.title}
                count={props.section.count}
                rightAccessory={props.section.headerRightAccessory}
            />
            {props.section.options.map((option) => renderRow(option))}
        </View>
    );
}
