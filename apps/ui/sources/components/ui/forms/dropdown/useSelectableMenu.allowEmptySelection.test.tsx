import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

describe('useSelectableMenu (allowEmptySelection)', () => {
    it('starts with no highlighted item when enabled and no preferred id exists', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        const items: SelectableMenuItem[] = [{ id: 'a', title: 'A', left: null, right: null }];

        const hook = await renderHook(() => useSelectableMenu({
            items,
            onRequestClose: () => {},
            allowEmptySelection: true,
        }));

        expect(hook.getCurrent().selectedIndex).toBe(-1);

        await hook.unmount();
    });
});

