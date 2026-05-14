import { describe, expect, it, vi } from 'vitest';

import type { SelectionListOption, SelectionListStep } from '../_types';

describe('SelectionListRowActivation (R14 extracted)', () => {
    function makeStep(id: string): SelectionListStep {
        return { id, sections: [] };
    }

    it('returns a no-op when the option is disabled', async () => {
        const { activateSelectionListRow } = await import('../SelectionListRowActivation');
        const onSelect = vi.fn();
        const onPushStep = vi.fn();
        const optionOnSelect = vi.fn();
        const option: SelectionListOption = {
            id: 'a',
            label: 'A',
            disabled: true,
            onSelect: optionOnSelect,
        };
        activateSelectionListRow({ option, onSelect, onPushStep });
        expect(onSelect).not.toHaveBeenCalled();
        expect(optionOnSelect).not.toHaveBeenCalled();
        expect(onPushStep).not.toHaveBeenCalled();
    });

    it('pushes the next step when openStep is set and never calls onSelect', async () => {
        const { activateSelectionListRow } = await import('../SelectionListRowActivation');
        const onSelect = vi.fn();
        const onPushStep = vi.fn();
        const next = makeStep('next');
        const option: SelectionListOption = {
            id: 'go',
            label: 'Go',
            openStep: next,
        };
        activateSelectionListRow({ option, onSelect, onPushStep });
        expect(onPushStep).toHaveBeenCalledTimes(1);
        expect(onPushStep).toHaveBeenCalledWith(next);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('invokes the option-level onSelect before bubbling to the orchestrator onSelect', async () => {
        const { activateSelectionListRow } = await import('../SelectionListRowActivation');
        const onSelect = vi.fn();
        const onPushStep = vi.fn();
        const order: string[] = [];
        const option: SelectionListOption = {
            id: 'a',
            label: 'A',
            onSelect: () => order.push('option'),
        };
        onSelect.mockImplementation(() => order.push('orchestrator'));
        activateSelectionListRow({ option, onSelect, onPushStep });
        expect(onPushStep).not.toHaveBeenCalled();
        expect(order).toEqual(['option', 'orchestrator']);
        expect(onSelect).toHaveBeenCalledWith('a', option);
    });

    it('still calls the orchestrator onSelect when the option has no onSelect callback', async () => {
        const { activateSelectionListRow } = await import('../SelectionListRowActivation');
        const onSelect = vi.fn();
        const onPushStep = vi.fn();
        const option: SelectionListOption = {
            id: 'a',
            label: 'A',
        };
        activateSelectionListRow({ option, onSelect, onPushStep });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith('a', option);
    });
});
