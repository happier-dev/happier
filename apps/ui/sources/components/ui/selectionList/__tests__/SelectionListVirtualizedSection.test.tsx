import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';
import { Pressable } from 'react-native';

import type { SelectionListOption, SelectionListSection } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

let legendListState: CapturingLegendListMockState;

vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({ renderItems: true, renderItemLimit: 20, memoizeItems: true }, state => {
        legendListState = state;
    });
});

function makeOptions(count: number, prefix = 'opt'): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Option ${i}`,
    }));
}

function makeSection(count: number): SelectionListSection {
    return {
        id: 'big-section',
        title: 'BIG',
        options: makeOptions(count),
    };
}

function hasAncestor(node: any, possibleAncestor: any): boolean {
    let current = node?.parent;
    while (current) {
        if (current === possibleAncestor) return true;
        current = current.parent;
    }
    return false;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

describe('SelectionListVirtualizedSection', () => {
    it('moves the selected marker between mounted cells without replacing the section options', async () => {
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const { SelectionListSelectedMarkContext } = await import('../SelectionListOptionPresentationContext');
        const section = makeSection(400);
        // The real body supplies the picker mark policy; bare section mounts default to no mark.
        const render = (id: string) => <SelectionListSelectedMarkContext.Provider value="check">
            <SelectionListVirtualizedSection section={section} stepId="root" rootTestID="sl"
                selectedOptionIds={new Set([id])} onSelect={() => {}} onPushStep={() => {}} />
        </SelectionListSelectedMarkContext.Provider>;
        const screen = await renderScreen(render('opt-0'));
        expect(screen.findByTestId('sl:root:option-selected-mark:opt-0')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option:opt-1')).not.toBeNull();
        await screen.update(render('opt-1'));
        expect(legendListState.props?.data).toBe(section.options);
        expect(screen.findByTestId('sl:root:option-selected-mark:opt-0')).toBeNull();
        expect(screen.findByTestId('sl:root:option-selected-mark:opt-1')).not.toBeNull();
    });

    it.each([false, true])('constructs lazy visuals only for the rendered window in the single-section path (measure: %s)', async measureMode => {
        legendListState.reset();
        const constructVisual = vi.fn((id: string) => <React.Fragment>{id}</React.Fragment>);
        const options: readonly SelectionListOption[] = Array.from({ length: 1_000 }, (_, index) => ({
            id: `lazy-${index}`,
            label: `Lazy ${index}`,
            subtitleContent: () => constructVisual(`subtitle-${index}`),
            icon: () => constructVisual(`icon-${index}`),
            rightAccessory: () => constructVisual(`accessory-${index}`),
        }));
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={{ id: 'lazy', options }}
                stepId="root"
                rootTestID="sl"
                measureMode={measureMode}
                selectedOptionIds={new Set<string>()}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(legendListState.props?.data).toHaveLength(1_000);
        expect(constructVisual).toHaveBeenCalledTimes(60);
        if (measureMode) {
            expect(screen.findByTestId('sl:section:lazy:virtualized')).toBeNull();
            expect(screen.findByTestId('sl:root:option:lazy-0')).toBeNull();
        }
    });

    it('renders the section through the virtualized list with every option as data', async () => {
        legendListState.reset();
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized/VirtualizedList');
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(screen.tree.root.findByType(VirtualizedList as React.ComponentType<any>).props.keyboardShouldPersistTaps)
            .toBe('handled');
        expect(legendListState.props?.recycleItems).toBe(false);
        expect(Array.isArray(legendListState.props.data)).toBe(true);
        expect(legendListState.props.data.length).toBe(60);
        expect(typeof legendListState.props.renderItem).toBe('function');
        expect(typeof legendListState.props.keyExtractor).toBe('function');
    });

    it('uses a shrinkable preferred height instead of a fixed minimum for short parent regions', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={{ ...makeSection(3), id: 'short-parent' }}
                stepId="root"
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        const hostStyle = flattenStyle(screen.findByTestId('sl:section:short-parent')?.props.style);
        expect(hostStyle.minHeight).toBe(0);
        expect(hostStyle.height).toBe(224);
        expect(hostStyle.maxHeight).toBe('100%');
    });

    it('keeps an interactive accessory outside the virtualized row pressable', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section: SelectionListSection = {
            ...makeSection(60),
            options: [
                {
                    id: 'interactive',
                    label: 'Interactive option',
                    rightAccessory: <Pressable testID="virtualized-row-action" onPress={() => {}} />,
                    rightAccessoryOutsidePressable: true,
                },
                ...makeOptions(59, 'remaining'),
            ],
        };
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(legendListState.props?.data).toHaveLength(60);
        const row = screen.findByTestId('sl:root:option:interactive');
        const action = screen.findByTestId('virtualized-row-action');
        expect(row).toBeTruthy();
        expect(action).toBeTruthy();
        expect(hasAncestor(action, row)).toBe(false);
    });

    it('renders the canonical row surface for virtualized rows (custom content, ellipsize modes, chevron retention, expanded body)', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section: SelectionListSection = {
            ...makeSection(60),
            options: [
                {
                    id: 'custom',
                    label: 'Custom body',
                    content: <Pressable testID="virtualized-custom-body" onPress={() => {}} />,
                },
                {
                    id: 'clamped',
                    label: 'A very long label',
                    subtitle: 'A very long subtitle',
                    labelEllipsizeMode: 'middle',
                    subtitleEllipsizeMode: 'head',
                    rightAccessory: <React.Fragment />,
                    keepChevronWithAccessory: true,
                    openStep: { id: 'child', sections: [] },
                },
                {
                    id: 'expanded',
                    label: 'Selected row',
                    expandedContent: <Pressable testID="virtualized-expanded" onPress={() => {}} />,
                },
                ...makeOptions(57, 'remaining'),
            ],
        };
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionIds={new Set(['expanded'])}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        // `option.content` is honored (the divergent renderer dropped it).
        expect(screen.findByTestId('virtualized-custom-body')).not.toBeNull();

        const clamped = screen.findAllByTestId('sl:root:option:clamped')
            .find((node) => typeof node.type === 'function');
        expect(clamped).toBeTruthy();
        expect(clamped!.props.titleEllipsizeMode).toBe('middle');
        expect(clamped!.props.subtitleEllipsizeMode).toBe('head');
        expect(clamped!.props.keepChevronWithRightElement).toBe(true);

        // The selected row's expanded body renders, outside its pressable.
        const expanded = screen.findByTestId('virtualized-expanded');
        expect(expanded).not.toBeNull();
        for (const rowNode of screen.findAllByTestId('sl:root:option:expanded')) {
            expect(hasAncestor(expanded, rowNode)).toBe(false);
        }
    });

    it('passes a stable keyExtractor that produces option ids', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        const ke = legendListState.props.keyExtractor as (option: SelectionListOption, i: number) => string;
        expect(ke(section.options[0], 0)).toBe(section.options[0].id);
        expect(ke(section.options[5], 5)).toBe(section.options[5].id);
    });
});
