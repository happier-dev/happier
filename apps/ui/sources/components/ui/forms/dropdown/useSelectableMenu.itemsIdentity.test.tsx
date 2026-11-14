import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

// Consumers commonly rebuild `items` on every render (the session header menu re-renders on every
// streamed transcript update). An equal list must not count as "the items changed".
function buildItems(): SelectableMenuItem[] {
    return [
        { id: 'a', title: 'A', left: null, right: null },
        { id: 'b', title: 'B', left: null, right: null },
        { id: 'c', title: 'C', left: null, right: null },
    ];
}

describe('useSelectableMenu (items identity)', () => {
    it('keeps the highlighted item when the parent re-renders with an equal items list', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        const hook = await renderHook(
            (props: { items: SelectableMenuItem[] }) => useSelectableMenu({ items: props.items, onRequestClose: () => {} }),
            { initialProps: { items: buildItems() } },
        );

        await act(async () => {
            hook.getCurrent().setSelectedIndex(2);
        });
        expect(hook.getCurrent().selectedIndex).toBe(2);

        await hook.rerender({ items: buildItems() });

        expect(hook.getCurrent().selectedIndex).toBe(2);
        await hook.unmount();
    });

    it('does not schedule a selection update per parent render while the items are unchanged', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        let renders = 0;
        const hook = await renderHook(
            (props: { items: SelectableMenuItem[] }) => {
                renders += 1;
                return useSelectableMenu({ items: props.items, onRequestClose: () => {} });
            },
            { initialProps: { items: buildItems() } },
        );
        await act(async () => {
            hook.getCurrent().setSelectedIndex(1);
        });
        const before = renders;

        for (let i = 0; i < 5; i += 1) {
            await hook.rerender({ items: buildItems() });
        }

        expect(renders - before).toBe(5);
        expect(hook.getCurrent().selectedIndex).toBe(1);
        await hook.unmount();
    });

    it('still resets the highlight when the items actually change', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        const hook = await renderHook(
            (props: { items: SelectableMenuItem[] }) => useSelectableMenu({ items: props.items, onRequestClose: () => {} }),
            { initialProps: { items: buildItems() } },
        );
        await act(async () => {
            hook.getCurrent().setSelectedIndex(2);
        });

        await hook.rerender({ items: [{ id: 'x', title: 'X', left: null, right: null }, ...buildItems()] });

        expect(hook.getCurrent().selectedIndex).toBe(0);
        await hook.unmount();
    });
});
