import { describe, expect, it, vi } from 'vitest';

import { activateSelectionListRow } from './SelectionListRowActivation';

describe('activateSelectionListRow', () => {
    it('routes a requiresInputValue row to onRequiresInput without selecting or navigating', () => {
        const onSelect = vi.fn();
        const onPushStep = vi.fn();
        const onRequiresInput = vi.fn();
        const rowOnSelect = vi.fn();
        activateSelectionListRow({
            option: { id: 'name-create', label: 'Type a name', requiresInputValue: true, onSelect: rowOnSelect },
            onSelect,
            onPushStep,
            onRequiresInput,
        });
        expect(onRequiresInput).toHaveBeenCalledTimes(1);
        expect(rowOnSelect).not.toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
        expect(onPushStep).not.toHaveBeenCalled();
    });

    it('selects normally when requiresInputValue is absent (option then orchestrator onSelect)', () => {
        const onSelect = vi.fn();
        const onRequiresInput = vi.fn();
        const rowOnSelect = vi.fn();
        const option = { id: 'pick', label: 'Pick', onSelect: rowOnSelect } as const;
        activateSelectionListRow({ option, onSelect, onPushStep: vi.fn(), onRequiresInput });
        expect(rowOnSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith('pick', option);
        expect(onRequiresInput).not.toHaveBeenCalled();
    });

    it('does nothing for a disabled row even when requiresInputValue is set', () => {
        const onRequiresInput = vi.fn();
        const onSelect = vi.fn();
        activateSelectionListRow({
            option: { id: 'x', label: 'x', disabled: true, requiresInputValue: true },
            onSelect,
            onPushStep: vi.fn(),
            onRequiresInput,
        });
        expect(onRequiresInput).not.toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('navigates via openStep when present (requiresInputValue not set)', () => {
        const onPushStep = vi.fn();
        const onRequiresInput = vi.fn();
        const step = { id: 'sub', sections: [] } as const;
        activateSelectionListRow({
            option: { id: 'nav', label: 'Nav', openStep: step },
            onSelect: vi.fn(),
            onPushStep,
            onRequiresInput,
        });
        expect(onPushStep).toHaveBeenCalledWith(step);
        expect(onRequiresInput).not.toHaveBeenCalled();
    });
});
