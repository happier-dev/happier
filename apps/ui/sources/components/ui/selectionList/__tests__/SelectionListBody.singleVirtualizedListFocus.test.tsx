import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListStep,
    SelectionListVirtualizedOptionSource,
} from '../_types';

const initialPlatform = Platform.OS;
afterEach(() => {
    Platform.OS = initialPlatform;
    act(() => setReducedMotionPreferenceOverride(null));
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Spy ref handle so we can assert that the body's flat-FlashList path calls
// scrollToIndex with the flattened index when the focused option lives in
// the SECOND virtualized section.
const scrollToIndex = vi.fn<(args: { index: number; animated?: boolean; viewPosition?: number }) => void>();
const scrollToOffset = vi.fn();

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    refHandle: { scrollToIndex, scrollToOffset },
});

vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    LegendList: capturedLegendList.LegendList,
}));

const { SelectionListBody } = await import('../SelectionListBody');

function makeOptions(count: number, prefix: string): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Label ${prefix}-${i}`,
    }));
}

function buildMultiSectionPlan(): ReadonlyArray<SectionRenderPlan> {
    return [
        {
            id: 'first',
            title: 'FIRST',
            options: makeOptions(60, 'first'),
            virtualization: 'force',
        },
        {
            id: 'second',
            title: 'SECOND',
            options: makeOptions(60, 'second'),
            virtualization: 'force',
        },
    ];
}

function buildMixedSectionPlan(): ReadonlyArray<SectionRenderPlan> {
    return [
        {
            id: 'native',
            title: 'NATIVE',
            options: makeOptions(7, 'native'),
        },
        {
            id: 'provider',
            title: 'PROVIDER',
            options: makeOptions(60, 'provider'),
            virtualization: 'force',
        },
        {
            id: 'other',
            title: 'OTHER',
            options: makeOptions(1, 'other'),
        },
    ];
}

function buildBodyStep(): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [],
    };
}

function buildDirectSource(): SelectionListVirtualizedOptionSource {
    const options = makeOptions(8, 'direct');
    return {
        items: options.map((option, optionIndex) => ({
            kind: 'option',
            key: option.id,
            optionIndex,
            positionInSet: optionIndex + 1,
        })),
        optionCount: options.length,
        stateKey: 'direct-v1',
        getOption: (index) => options[index]!,
        getOptionId: (index) => options[index]?.id ?? '',
        findOptionIndexById: (id) => options.findIndex((option) => option.id === id),
        getFirstFocusableOptionIndex: () => 0,
        getNextFocusableOptionIndex: (current, direction) => (
            (current + direction + options.length) % options.length
        ),
        isFocusableOptionIndex: (index) => index >= 0 && index < options.length,
        getHeader: () => ({ id: 'unused' }),
    };
}

/**
 * RV-9 / FRESH-3 — Focus-driven scroll on the flat-FlashList multi-section
 * body path. When the keyboard focus lands on an option that lives in the
 * SECOND (or any subsequent) virtualized section, the body must call
 * FlashList.scrollToIndex with the FLATTENED index (including section-
 * header offsets) so the focused row is centered in the viewport.
 */
describe('SelectionListBody flat virtualized-list focused-row scroll (RV-9)', () => {
    it('reveals the actual cell offset inside a tall column block, including cells laid out after focus', async () => {
        Platform.OS = 'ios';
        const plan: ReadonlyArray<SectionRenderPlan> = [{ id: 'models', options: makeOptions(50, 'model'), virtualization: 'force' }];
        const props = { step: buildBodyStep(), rootTestID: 'sl', selectedOptionIds: new Set<string>(), plan,
            columnCount: 2, declaresColumns: true, listboxId: 'listbox', onSelect() {}, onPushStep() {} };
        const screen = await renderScreen(<SelectionListBody {...props} focusedOptionId="model-48" />);
        legendListState.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height: 400 } } });
        const last = screen.findByTestId('sl:root:option-wrapper:model-48')!;
        // The option is inside a cell frame stacked 1,440px down the first column.
        let cellFrame = last.parent;
        while (cellFrame && !(typeof cellFrame.type === 'string' && typeof cellFrame.props.onLayout === 'function')) cellFrame = cellFrame.parent;
        if (!cellFrame) throw new Error('Missing cell layout frame');
        const lastCellFrame = cellFrame;
        await act(async () => {
            last.props.onLayout?.({ nativeEvent: { layout: { y: 0, height: 60 } } });
            lastCellFrame.props.onLayout?.({ nativeEvent: { layout: { y: 1440, height: 60 } } });
        });
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, viewPosition: 0, viewOffset: -1440, animated: true });
        scrollToIndex.mockClear();
        await screen.update(<SelectionListBody {...props} focusedOptionId="model-0" />);
        const first = screen.findByTestId('sl:root:option-wrapper:model-0')!;
        await act(async () => { first.props.onLayout?.({ nativeEvent: { layout: { y: 0, height: 60 } } }); });
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, viewPosition: 0, viewOffset: 0, animated: true });
        // A label refresh does not cause native layout events for unchanged cell geometry.
        const refreshedPlan = [{ ...plan[0]!, options: plan[0]!.options.map(option => ({ ...option, label: `Updated ${option.label}` })) }];
        scrollToIndex.mockClear();
        await screen.update(<SelectionListBody {...props} plan={refreshedPlan} focusedOptionId="model-0" />);
        const refreshedFirst = screen.findByTestId('sl:root:option-wrapper:model-0')!;
        await act(async () => { refreshedFirst.props.onLayout?.({ nativeEvent: { layout: { y: 20, height: 60 } } }); });
        expect(scrollToIndex).not.toHaveBeenCalled();
        scrollToIndex.mockClear();
        await screen.update(<SelectionListBody {...props} plan={refreshedPlan} focusedOptionId="model-48" />);
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, viewPosition: 0, viewOffset: -1440, animated: true });
        await screen.update(<SelectionListBody {...props} plan={refreshedPlan} focusedOptionId="model-0" />);
        scrollToIndex.mockClear();
        const reorderedPlan = [{ ...plan[0]!, options: [...plan[0]!.options].reverse() }];
        await screen.update(<SelectionListBody {...props} plan={reorderedPlan} focusedOptionId="model-0" />);
        const moved = screen.findByTestId('sl:root:option-wrapper:model-0')!;
        await act(async () => { moved.props.onLayout?.({ nativeEvent: { layout: { y: 1440, height: 60 } } }); });
        expect(scrollToIndex).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        setReducedMotionPreferenceOverride(false);
        scrollToIndex.mockClear();
        scrollToOffset.mockClear();
    });

    it('calls scrollToIndex with the flattened index when focused option is in the SECOND virtualized section', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(scrollToIndex).not.toHaveBeenCalled();
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMultiSectionPlan()}
                focusedOptionId="second-4"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // Expected flattened index: 1 (first header) + 60 (first rows)
        //   + 1 (second header) + 4 (second-0..second-4) = 66.
        expect(scrollToIndex).toHaveBeenCalled();
        const call = scrollToIndex.mock.calls.at(-1)?.[0];
        expect(call?.index).toBe(66);
        expect(call?.viewPosition).toBe(0.5);
        expect(call?.animated).toBe(true);
    });

    it('uses the body owner and flattened index when one eligible section has plain neighbors', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMixedSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMixedSectionPlan()}
                focusedOptionId="provider-10"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        // [native header, 7 native rows, provider header, provider-0..10]
        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 19,
            viewPosition: 0.5,
            animated: true,
        });
    });

    it('reveals the focused flattened row again after the viewport is resized', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMultiSectionPlan()}
                focusedOptionId="second-4"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        scrollToIndex.mockClear();
        legendListState.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
        expect(scrollToIndex).not.toHaveBeenCalled();

        legendListState.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 240 } } });
        expect(scrollToIndex).toHaveBeenCalledTimes(1);
        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 66,
            viewPosition: 0.5,
            animated: true,
        });
    });

    it('reveals the focused direct-source row again after the viewport is resized', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const source = buildDirectSource();
        await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={[]}
                virtualizedOptionSource={source}
                focusedOptionId="direct-5"
                focusedOptionIndex={5}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        scrollToIndex.mockClear();
        legendListState.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
        expect(scrollToIndex).not.toHaveBeenCalled();

        legendListState.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 240 } } });
        expect(scrollToIndex).toHaveBeenCalledTimes(1);
        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 5,
            viewPosition: 0.5,
            animated: true,
        });
    });

    it('scrolls the flat recycler without animation when reduced motion is enabled', async () => {
        setReducedMotionPreferenceOverride(true);
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={buildMultiSectionPlan()}
                focusedOptionId="second-4"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(scrollToIndex).toHaveBeenCalledWith({ index: 66, viewPosition: 0.5, animated: false });
    });
});
