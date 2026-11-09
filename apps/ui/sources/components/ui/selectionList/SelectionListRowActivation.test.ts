import { describe, expect, it } from 'vitest';
import type { GestureResponderEvent } from 'react-native';

import { activateSelectionListRow } from './SelectionListRowActivation';
import type { SelectionListOption, SelectionListStep } from './_types';

function activation() {
    const events: unknown[] = [];
    return {
        events,
        onSelect: (id: string, option: SelectionListOption) => { events.push({ selected: id, option }); },
        onPushStep: (step: SelectionListStep) => { events.push({ step }); },
        onRequiresInput: () => { events.push('input'); },
    };
}

describe('activateSelectionListRow', () => {
    it('routes a requiresInputValue row to onRequiresInput without selecting or navigating', () => {
        const callbacks = activation();
        activateSelectionListRow({
            ...callbacks,
            option: { id: 'name-create', label: 'Type a name', requiresInputValue: true,
                onSelect: () => { callbacks.events.push('option'); } },
        });
        expect(callbacks.events).toEqual(['input']);
    });

    it('selects normally when requiresInputValue is absent (option then orchestrator onSelect)', () => {
        const callbacks = activation();
        // The event is a native/browser boundary fixture; activation preserves it without reading its payload.
        const event = {} as GestureResponderEvent;
        const option = { id: 'pick', label: 'Pick', onSelect: (pressed?: GestureResponderEvent) => { callbacks.events.push(pressed); } };
        activateSelectionListRow({ ...callbacks, option, event });
        expect(callbacks.events).toEqual([event, { selected: 'pick', option }]);
    });

    it.each([false, true])('does nothing for a disabled row (requiresInputValue=%s)', (requiresInputValue) => {
        const callbacks = activation();
        activateSelectionListRow({
            ...callbacks,
            option: { id: 'x', label: 'x', disabled: true, requiresInputValue,
                onSelect: () => { callbacks.events.push('option'); } },
        });
        expect(callbacks.events).toEqual([]);
    });

    it('navigates via openStep when present (requiresInputValue not set)', () => {
        const callbacks = activation();
        const step = { id: 'sub', sections: [] } as const;
        activateSelectionListRow({
            ...callbacks,
            option: { id: 'nav', label: 'Nav', openStep: step },
        });
        expect(callbacks.events).toEqual([{ step }]);
    });

    it('selects a plain option without requiring an option-level callback', () => {
        const callbacks = activation();
        const option = { id: 'pick', label: 'Pick' };
        activateSelectionListRow({ ...callbacks, option });
        expect(callbacks.events).toEqual([{ selected: 'pick', option }]);
    });
});
