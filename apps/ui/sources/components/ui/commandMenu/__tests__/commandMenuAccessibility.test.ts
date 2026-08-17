import { describe, expect, it } from 'vitest';

import { resolveCommandMenuComboboxAccessibility } from '../commandMenuAccessibility';

const ITEMS = [
    { id: 'file:README.md', label: 'README.md' },
    { id: 'vendorPlugin:notes', label: 'Notes' },
] as const;

describe('command menu combobox accessibility identity', () => {
    it('uses the SelectionList owner ids for the popup and selected candidate', () => {
        expect(resolveCommandMenuComboboxAccessibility({
            testID: 'agent-input-command-menu',
            items: ITEMS,
            selectedIndex: 1,
        })).toEqual({
            listboxId: 'agent-input-command-menu:list:listbox',
            activeDescendantId:
                'agent-input-command-menu:list:command-menu-root:option:vendorPlugin:notes',
        });
    });

    it('omits an active descendant when no current row is selected', () => {
        expect(resolveCommandMenuComboboxAccessibility({
            testID: 'agent-input-command-menu',
            items: ITEMS,
            selectedIndex: -1,
        })).toEqual({
            listboxId: 'agent-input-command-menu:list:listbox',
        });
    });
});
