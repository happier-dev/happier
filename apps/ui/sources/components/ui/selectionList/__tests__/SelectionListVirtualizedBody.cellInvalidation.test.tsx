import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

// Cell render work at the recycler boundary: the canonical Legend mock keeps a cell mounted until its
// item or the list's `extraData` changes, exactly like the shipped recycler's containers.
const cells = vi.hoisted(() => ({ renders: 0 }));
// A row's own content: native text is the observable rendering boundary beneath the memoized row.
const rowText = vi.hoisted(() => ({ renders: 0 }));

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Text: (props: { children?: React.ReactNode }) => {
            if (props.children === 'Label provider-6') rowText.renders += 1;
            return React.createElement('NativeText', props);
        },
    });
});

vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({
        renderItems: true,
        memoizeItems: true,
        onRenderItem: () => { cells.renders += 1; },
    });
});

function makeOptions(count: number, prefix: string): SelectionListOption[] {
    return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, label: `Label ${prefix}-${i}` }));
}

const NATIVE = makeOptions(2, 'native');
const PROVIDER = makeOptions(40, 'provider');

function step(providerOptions: ReadonlyArray<SelectionListOption>): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            { kind: 'static', id: 'native', title: 'NATIVE', options: NATIVE },
            { kind: 'static', id: 'provider', title: 'PROVIDER', options: providerOptions, virtualization: 'force' },
        ],
    };
}

// A host's callback identity is not a row fact: the body invokes the newest one through a stable
// handler (see below), so only option facts redraw a cell.
const onSelect = vi.fn();
const onRequestClose = vi.fn();

function props(rootStep: SelectionListStep): SelectionListProps {
    return {
        rootStep,
        onSelect,
        onRequestClose,
        keyboardHintsEnabled: false,
        disableTransitions: true,
        maxHeight: 300,
        testID: 'sl',
    };
}

function makeKeyEvent(key: string) {
    return { key, nativeEvent: { key }, preventDefault: () => {}, stopPropagation: () => {} };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The host node that carries an option's DOM identity (its `id` ends with the option id). */
function optionHost(screen: Screen, optionId: string) {
    return screen.tree.root.findAll((node) => (
        typeof node.type === 'string' && typeof node.props?.id === 'string' && node.props.id.endsWith(optionId)
    ))[0];
}

describe('SelectionList flat virtualized body: cell invalidation', () => {
    it('moves the highlight without redrawing every recycled cell', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...props(step(PROVIDER))} />);
        await act(async () => { await Promise.resolve(); });
        const press = async () => {
            const header = screen.findAllByTestId('sl:header').find((node) => typeof node.props?.onKeyPress === 'function');
            await act(async () => { (header!.props.onKeyPress as (event: unknown) => void)(makeKeyEvent('ArrowDown')); });
        };
        await press();
        cells.renders = 0;
        for (let index = 0; index < 3; index += 1) await press();

        // 44 cells (2 headers + 42 options): the highlight moved across 3 rows, no cell changed.
        expect(cells.renders).toBe(0);
        // The highlight still follows the keyboard: the input points at the 5th option, which paints focused.
        const input = screen.findByTestId('sl:header:input');
        const focusedId = input?.props['aria-activedescendant'] as string;
        expect(focusedId).toContain('provider-2');
        const focusedRows = screen.tree.root.findAll((node) => node.props?.option !== undefined && node.props?.isFocused === true);
        expect(focusedRows.map((node) => node.props.option.id)).toEqual(['provider-2']);
    });

    it('keeps every cell when the host hands a fresh select callback, and still calls the newest one', async () => {
        const { SelectionList } = await import('../SelectionList');
        const firstSelect = vi.fn();
        const screen = await renderScreen(<SelectionList {...props(step(PROVIDER))} onSelect={firstSelect} />);
        await act(async () => { await Promise.resolve(); });
        cells.renders = 0;
        rowText.renders = 0;
        const latestSelect = vi.fn();
        await screen.update(<SelectionList {...props(step(PROVIDER))} onSelect={latestSelect} />);
        await act(async () => { await Promise.resolve(); });

        expect(cells.renders).toBe(0);
        expect(rowText.renders).toBe(0);
        const row = screen.tree.root.findAll((node) => node.props?.option?.id === 'provider-3' && typeof node.props?.onSelect === 'function')[0];
        await act(async () => { (row!.props.onSelect as (id: string, option: unknown) => void)('provider-3', row!.props.option); });
        expect(latestSelect).toHaveBeenCalledTimes(1);
        expect(firstSelect).not.toHaveBeenCalled();
    });

    it('keeps every cell when a result leaves the list and only the set size changes', async () => {
        const { SelectionList } = await import('../SelectionList');
        rowText.renders = 0;
        const screen = await renderScreen(<SelectionList {...props(step(PROVIDER))} />);
        await act(async () => { await Promise.resolve(); });
        expect(rowText.renders).toBeGreaterThan(0);
        cells.renders = 0;
        rowText.renders = 0;
        // The last result drops out (a refined query): 42 → 41 options. Every other row is the same row
        // at the same index, so only the set size it shows changes.
        await screen.update(<SelectionList {...props(step(PROVIDER.filter((option) => option.id !== 'provider-39')))} />);
        await act(async () => { await Promise.resolve(); });

        expect(cells.renders).toBe(0);
        // Nor does any row redraw its content: the new set size is written by each option's own element.
        expect(rowText.renders).toBe(0);
        // Set size and positions still reach every remaining row.
        const after = optionHost(screen, 'provider-6');
        expect(after?.props['aria-setsize']).toBe(41);
        expect(after?.props['aria-posinset']).toBe(9);
        const first = optionHost(screen, 'native-0');
        expect(first?.props['aria-setsize']).toBe(41);
    });

    it('renumbers rows below a result that leaves without redrawing their content', async () => {
        const { SelectionList } = await import('../SelectionList');
        rowText.renders = 0;
        const screen = await renderScreen(<SelectionList {...props(step(PROVIDER))} />);
        await act(async () => { await Promise.resolve(); });
        expect(rowText.renders).toBeGreaterThan(0);
        rowText.renders = 0;
        // A result above provider-6 drops out: provider-6 moves from position 9 to 8.
        await screen.update(<SelectionList {...props(step(PROVIDER.filter((option) => option.id !== 'provider-0')))} />);
        await act(async () => { await Promise.resolve(); });

        expect(rowText.renders).toBe(0);
        expect(optionHost(screen, 'provider-6')?.props['aria-posinset']).toBe(8);
        expect(optionHost(screen, 'provider-6')?.props['aria-setsize']).toBe(41);
    });
});
