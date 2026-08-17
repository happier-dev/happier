import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

    it('uses the shared edge, typeahead, activation, and Escape semantics', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        const onRequestClose = vi.fn();
        const onActivate = vi.fn();
        const items: SelectableMenuItem[] = [
            { id: 'alpha', title: 'Alpha', left: null, right: null },
            { id: 'disabled', title: 'Archive', disabled: true, left: null, right: null },
            { id: 'beta', title: 'Beta', left: null, right: null },
            { id: 'gamma', title: 'Gamma', left: null, right: null },
        ];

        const hook = await renderHook(() => useSelectableMenu({
            items,
            onRequestClose,
        }));

        await act(async () => {
            hook.getCurrent().handleKeyPress('End', onActivate);
        });
        expect(hook.getCurrent().selectedIndex).toBe(3);

        await act(async () => {
            hook.getCurrent().handleKeyPress('ArrowDown', onActivate);
        });
        expect(hook.getCurrent().selectedIndex).toBe(3);

        await act(async () => {
            hook.getCurrent().handleKeyPress('Home', onActivate);
        });
        expect(hook.getCurrent().selectedIndex).toBe(0);

        await act(async () => {
            hook.getCurrent().handleKeyPress('g', onActivate);
        });
        expect(hook.getCurrent().selectedIndex).toBe(3);

        await act(async () => {
            hook.getCurrent().handleKeyPress('Enter', onActivate);
            hook.getCurrent().handleKeyPress('Escape', onActivate);
        });
        expect(onActivate).toHaveBeenCalledWith(items[3]);
        expect(onRequestClose).toHaveBeenCalledOnce();

        await hook.unmount();
    });

    it('clears typeahead when a controlled menu closes before reopening', async () => {
        const { useSelectableMenu } = await import('./useSelectableMenu');
        const items: SelectableMenuItem[] = [
            { id: 'alpha', title: 'Alpha', left: null, right: null },
            { id: 'disabled', title: 'Archive', disabled: true, left: null, right: null },
            { id: 'beta', title: 'Beta', left: null, right: null },
            { id: 'gamma', title: 'Gamma', left: null, right: null },
        ];
        const hook = await renderHook(
            ({ open }: { open: boolean }) => useSelectableMenu({
                items,
                onRequestClose: () => {},
                open,
            }),
            { initialProps: { open: true } },
        );

        await act(async () => {
            hook.getCurrent().handleKeyPress('g', () => {});
        });
        expect(hook.getCurrent().selectedIndex).toBe(3);

        await hook.rerender({ open: false });
        await hook.rerender({ open: true });
        await act(async () => {
            hook.getCurrent().handleKeyPress('a', () => {});
        });
        expect(hook.getCurrent().selectedIndex).toBe(0);

        await hook.unmount();
    });
});
