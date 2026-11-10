import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListFilter, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const rootStep: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search Codex sessions…',
    sections: [{ kind: 'static', id: 'rows', options: [{ id: 'row-a', label: 'Row A' }] }],
};

function agentFilter(overrides: Partial<SelectionListFilter> = {}): SelectionListFilter {
    return {
        id: 'agent',
        label: 'Agent',
        options: [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }],
        selectedId: 'codex',
        onChange: vi.fn(),
        testID: 'filter.agent',
        ...overrides,
    };
}

function props(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

// Test Renderer has no DOM geometry for the real popover's anchor measurement.
const renderOptions = {
    createNodeMock: () => ({
        getBoundingClientRect: () => ({ left: 20, top: 40, width: 100, height: 32 }),
    }),
};

function isExpanded(screen: Screen, testID: string): boolean | undefined {
    const chip = screen.findHostByTestId(testID);
    return chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded'];
}

async function layoutRoot(screen: Screen, width: number) {
    const root = screen.findByTestId('sl');
    await act(async () => {
        root?.props.onLayout?.({ nativeEvent: { layout: { width, height: 600, x: 0, y: 0 } } });
    });
}

// Filters are a SelectionList feature: one chip per filter beside the field, a small popover to
// change it, and a row of their own beneath the field when the list is too narrow for both.
describe('SelectionList filters', () => {
    it('shows each filter as a chip naming its value, and a chosen option reaches the consumer', () => withPopoverWebGlobals(async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<SelectionList {...props({ filters: [agentFilter({ onChange })] })} />, renderOptions);

        const chip = screen.findHostByTestId('filter.agent');
        expect(chip).not.toBeNull();
        expect(chip?.props.accessibilityLabel ?? chip?.props['aria-label']).toBe('Agent: Codex');
        expect(screen.findHostByTestId('filter.agent.list')).toBeNull();

        await screen.pressByTestIdAsync('filter.agent');
        expect(screen.findHostByTestId('filter.agent.list')).not.toBeNull();
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 280, height: 160 }));

        await screen.pressByTestIdAsync('filter.agent:claude');
        expect(onChange).toHaveBeenCalledWith('claude');
        // Choosing closes the popover.
        expect(isExpanded(screen, 'filter.agent')).toBe(false);
    }));

    it('keeps chips beside the field when wide and moves them to their own row beneath it when narrow', async () => {
        const screen = await renderScreen(<SelectionList {...props({ filters: [agentFilter()] })} />);
        const inRow = () => screen.findByTestId('sl:filters-row')?.findAll((node) => node.props?.testID === 'filter.agent').length ?? 0;

        await layoutRoot(screen, 900);
        expect(screen.findHostByTestId('filter.agent')).not.toBeNull();
        expect(inRow()).toBe(0);

        await layoutRoot(screen, 390);
        expect(inRow()).toBeGreaterThan(0);
        // The row is part of the header zone, never the scrolling results.
        const header = screen.findByTestId('sl:headerFrame');
        expect(header?.findAll((node) => node.props?.testID === 'sl:filters-row').length).toBeGreaterThan(0);
    });

    it('keeps the filter that scopes the search on the field row when narrow, naming the filter until it has a value', async () => {
        const machine: SelectionListFilter = { id: 'machine', label: 'Machine', valueLabel: 'Choose a machine', muted: true,
            pairsWithSearch: true, testID: 'filter.machine' };
        const screen = await renderScreen(<SelectionList {...props({ filters: [machine, agentFilter()] })} />);
        const inside = (zone: string, chip: string) => screen.findByTestId(zone)?.findAll((node) => node.props?.testID === chip).length ?? 0;

        await layoutRoot(screen, 390);
        expect(inside('sl:inline-controls', 'filter.machine')).toBeGreaterThan(0);
        expect(inside('sl:filters-row', 'filter.machine')).toBe(0);
        expect(inside('sl:filters-row', 'filter.agent')).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('Choose a machine');
        const chip = screen.findHostByTestId('filter.machine');
        expect(chip?.props.accessibilityLabel ?? chip?.props['aria-label']).toBe('Machine: Choose a machine');
    });

    it('draws the short value in the chip row while the accessible name and the wide chip keep the whole value', async () => {
        const scope = { id: 'source', label: 'Search', valueLabel: 'Text in happier · MacBook Pro', rowValueLabel: 'Text in happier',
            onClear: vi.fn(), testID: 'filter.source' };
        const screen = await renderScreen(<SelectionList {...props({ filters: [scope] })} />);
        const chipText = () => screen.getTextContent();
        const accessibleName = () => {
            const chip = screen.findHostByTestId('filter.source');
            return chip?.props.accessibilityLabel ?? chip?.props['aria-label'];
        };

        await layoutRoot(screen, 900);
        expect(chipText()).toContain('Text in happier · MacBook Pro');
        expect(accessibleName()).toContain('Text in happier · MacBook Pro');

        await layoutRoot(screen, 390);
        expect(screen.findByTestId('sl:filters-row')).not.toBeNull();
        expect(chipText()).toContain('Text in happier');
        expect(chipText()).not.toContain('MacBook Pro');
        expect(accessibleName()).toContain('Text in happier · MacBook Pro');
    });

    it('moves chips to their own row when the band controls would squeeze the field, on a wide list too', async () => {
        const screen = await renderScreen(<SelectionList {...props({ filters: [agentFilter()], inputSuffix: <></> })} />);
        const inRow = () => screen.findByTestId('sl:filters-row')?.findAll((node) => node.props?.testID === 'filter.agent').length ?? 0;

        await layoutRoot(screen, 1000);
        expect(inRow()).toBe(0);
        // The inline chips plus the consumer's controls measure 760 px: the field would get under its minimum.
        const suffix = screen.findByTestId('sl:inline-controls');
        await act(async () => {
            suffix?.props.onLayout?.({ nativeEvent: { layout: { width: 760, height: 32, x: 0, y: 0 } } });
        });
        expect(inRow()).toBeGreaterThan(0);

        // A wider list fits the field and the same controls again.
        await layoutRoot(screen, 1400);
        expect(inRow()).toBe(0);
    });

    it('recomposes filters that arrive after the list was laid out without replacing the query input', () => withPopoverWebGlobals(async () => {
        const listProps = props({ inputValue: 'Row', onChangeInputValue: vi.fn() });
        const onChange = vi.fn();
        const screen = await renderScreen(<SelectionList {...listProps} />, renderOptions);
        const input = screen.findHostByTestId('sl:header:input');

        // Scope choices can hydrate after Search has mounted. React Native Web
        // observes a host's layout on mount, so the width must already be known.
        await layoutRoot(screen, 390);
        await screen.update(<SelectionList {...listProps} filters={[agentFilter({ onChange })]} />);

        const row = screen.findByTestId('sl:filters-row');
        expect(row).not.toBeNull();
        expect(row!.findAll((node) => node.props?.testID === 'filter.agent').length).toBeGreaterThan(0);
        expect(screen.findHostByTestId('sl:header:input')).toBe(input);
        expect(screen.findHostByTestId('sl:header:input')?.props.value).toBe('Row');
        screen.changeTextByTestId('sl:header:input', 'Row A');
        expect(listProps.onChangeInputValue).toHaveBeenCalledWith('Row A');

        await screen.pressByTestIdAsync('filter.agent');
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 280, height: 160 }));
        await screen.pressByTestIdAsync('filter.agent:claude');
        expect(onChange).toHaveBeenCalledWith('claude');

        await layoutRoot(screen, 900);
        expect(screen.findByTestId('sl:filters-row')).toBeNull();
        expect(screen.findHostByTestId('sl:header:input')).toBe(input);
    }));

    it('closes an open filter popover on Escape before the list itself closes', () => withPopoverWebGlobals(async () => {
        const onRequestClose = vi.fn();
        const screen = await renderScreen(<SelectionList {...props({ onRequestClose, filters: [agentFilter()] })} />);

        await screen.pressByTestIdAsync('filter.agent');
        // The popover's own SelectionList (the composite that owns its keyboard and Escape).
        const popoverList = screen.findAll((node) => node.props?.testID === 'filter.agent.list'
            && typeof node.props?.onRequestClose === 'function')[0];
        expect(popoverList).toBeDefined();
        // Escape inside the popover's list reaches that list's close, not the outer list's.
        await act(async () => {
            popoverList?.props.onRequestClose?.();
        });
        expect(isExpanded(screen, 'filter.agent')).toBe(false);
        expect(onRequestClose).not.toHaveBeenCalled();
    }));

    it('lets a filter owner draw its own chooser, and shows a fixed scope that does not open', () => withPopoverWebGlobals(async () => {
        const screen = await renderScreen(<SelectionList {...props({
            filters: [
                {
                    id: 'machine',
                    label: 'Machine',
                    valueLabel: 'MacBook Pro',
                    presence: 'online',
                    testID: 'filter.machine',
                    renderPopoverContent: ({ close }) => React.createElement('MachineList', { testID: 'machine-list', onPick: close }),
                },
                { id: 'source', label: 'Source', valueLabel: 'Personal', testID: 'filter.source' },
            ],
        })} />);

        await screen.pressByTestIdAsync('filter.machine');
        const list = screen.findByTestId('machine-list');
        expect(list).not.toBeNull();
        expect(isExpanded(screen, 'filter.machine')).toBe(true);
        await act(async () => { list?.props.onPick(); });
        expect(isExpanded(screen, 'filter.machine')).toBe(false);

        const fixed = screen.findHostByTestId('filter.source');
        expect(fixed?.props.disabled ?? fixed?.props.accessibilityState?.disabled ?? fixed?.props['aria-disabled']).toBe(true);
    }));
});
