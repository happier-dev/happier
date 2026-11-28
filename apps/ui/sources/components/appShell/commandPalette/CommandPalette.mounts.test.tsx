import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { Command } from './types';
import { SelectionList, type SelectionListSectionDescriptor, type SelectionListStep } from '@/components/ui/selectionList';
import { SelectionListBodyVirtualized } from '@/components/ui/selectionList/SelectionListVirtualizedBody';
import { PlanOptionRow } from '@/components/ui/selectionList/SelectionListOptionRow';
import { buildCommandPaletteSelectionListSections } from './buildCommandPaletteSelectionListSections';
import type { SectionRenderPlan } from '@/components/ui/selectionList/SelectionListRenderPlan';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    // The native recycler/layout boundary paints one window; all selection, filtering and rows stay real.
    return createLegendListModuleMock({ renderItems: true, renderItemLimit: 12, memoizeItems: true });
});

describe('command palette row lifetime', () => {
    it('puts current Session commands first only before a query, preserving ordinary search grouping', () => {
        const commands: Command[] = [
            { id: 'general', title: 'Rename preset', category: 'Actions', action: () => {} },
            { id: 'session', title: 'Rename session', category: 'Actions', contextCategory: 'My project', action: () => {} },
        ];
        const empty = buildCommandPaletteSelectionListSections(commands);
        expect(empty[0]?.title).toBe('My project');
        expect(empty[0]?.kind === 'static' && empty[0].options[0]?.id).toBe('command:session');
        const searching = buildCommandPaletteSelectionListSections(commands, empty, 'rename');
        expect(searching.map(section => section.title)).toEqual(['Actions']);
        expect(searching[0]?.kind === 'static' && searching[0].options.map(option => option.id))
            .toEqual(['command:general', 'command:session']);
    });
    it('retains a visible result when its source refresh fails and recovers', async () => {
        const option = { id: 'retained-session', label: 'Session' };
        const props = (dynamicState?: SectionRenderPlan['dynamicState']) => ({
            rootTestID: 'palette', stepId: 'palette', listboxAria: null,
            plan: [{ id: 'sessions', options: [option], ...(dynamicState ? { dynamicState, isStale: true, skeletonRowCount: 0 } : {}) }],
            selectedOptionIds: new Set<string>(), focusedOptionId: null, onSelect: () => {}, onPushStep: () => {},
        });
        const screen = await renderScreen(<SelectionListBodyVirtualized {...props()} />);
        const row = screen.findAllByType(PlanOptionRow)[0];
        for (const state of ['loading', 'error', undefined] as const) {
            await screen.update(<SelectionListBodyVirtualized {...props(state)} />);
            expect(screen.findAllByType(PlanOptionRow)).toHaveLength(1);
            expect(screen.findAllByType(PlanOptionRow)[0] === row).toBe(true);
        }
    });

    it('mounts only the viewport on the first key and retains unchanged rows on refinement', async () => {
        // REPLAY67B observed 81 options across categories, each below the per-section threshold.
        const commands: Command[] = Array.from({ length: 81 }, (_, index) => ({
            id: `command-${index}`, title: `Session ${index}`, category: `Category ${Math.floor(index / 27)}`,
            action: () => {},
        }));
        let previousSections: readonly SelectionListSectionDescriptor[] = [];
        const props = (query: string) => {
            previousSections = buildCommandPaletteSelectionListSections(query ? commands : commands.slice(0, 2), previousSections);
            const rootStep: SelectionListStep = { id: 'palette', inputPlaceholder: 'Search', sections: previousSections,
                virtualization: 'force' };
            return { rootStep, inputValue: query, fillAvailableSpace: true, keyboardHintsEnabled: false,
                onSelect: () => {}, onRequestClose: () => {}, testID: 'palette' };
        };
        const screen = await renderScreen(<SelectionList {...props('')} />);
        const original = screen.findAllByType(PlanOptionRow).map(row => ({ id: row.props.option.id, instance: row }));
        await screen.update(<SelectionList {...props('s')} />);
        const first = screen.findAllByType(PlanOptionRow);
        expect(first.length).toBeGreaterThan(2);
        expect(first.length).toBeLessThanOrEqual(12);
        for (const row of original) expect(first.find(next => next.props.option.id === row.id) === row.instance).toBe(true);
        await screen.update(<SelectionList {...props('se')} />);
        const second = screen.findAllByType(PlanOptionRow);
        expect(second).toHaveLength(first.length);
        for (const row of first) expect(second.find(next => next.props.option.id === row.props.option.id) === row).toBe(true);
    });

    it('keeps a command category and its row identity when other categories become demanded', () => {
        const command: Command = { id: 'session', title: 'Session', category: 'Sessions', action: () => {} };
        const before = buildCommandPaletteSelectionListSections([command]);
        const after = buildCommandPaletteSelectionListSections([
            { id: 'settings', title: 'Settings', category: 'Settings', action: () => {} }, command,
        ], before);
        const retained = after.find(section => section.kind === 'static' && section.options.some(option => option.id === 'command:session'));
        expect(after.find(section => section.title === 'Sessions')?.id).toBe(before[0]?.id);
        expect(before[0]?.kind).toBe('static');
        expect(retained?.kind).toBe('static');
        if (before[0]?.kind !== 'static' || retained?.kind !== 'static') throw new Error('Expected the retained command category');
        expect(retained.options[0]).toBe(before[0].options[0]);
    });
});
