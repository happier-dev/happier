import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

const swatch = (id: string, group: string): SelectableMenuItem => ({ id, title: id, swatch: { color: '#000000', group } });

async function renderMenu(items: SelectableMenuItem[]) {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const onRequestClose = vi.fn();
    const hook = await renderHook(() => useSelectableMenu({ items, onRequestClose }));
    const press = async (key: string, nav?: Parameters<ReturnType<typeof useSelectableMenu>['handleKeyPress']>[2]) => {
        const onActivate = vi.fn();
        await act(async () => {
            hook.getCurrent().handleKeyPress(key, onActivate, nav);
        });
        return onActivate;
    };
    const selectedId = () => items[hook.getCurrent().selectedIndex]?.id;
    return { hook, press, selectedId };
}

describe('useSelectableMenu keyboard', () => {
    it('moves left and right within a swatch row and up and down between rows', async () => {
        const menu = await renderMenu([
            swatch('blue', 'presets'), swatch('green', 'presets'), swatch('red', 'presets'),
            swatch('#123456', 'custom'),
            { id: 'custom-picker', title: 'Custom' },
        ]);
        expect(menu.selectedId()).toBe('blue');

        await menu.press('ArrowRight');
        await menu.press('ArrowRight');
        expect(menu.selectedId()).toBe('red');
        await menu.press('ArrowRight');
        expect(menu.selectedId()).toBe('red');
        await menu.press('ArrowLeft');
        expect(menu.selectedId()).toBe('green');

        await menu.press('ArrowDown');
        expect(menu.selectedId()).toBe('#123456');
        await menu.press('ArrowDown');
        expect(menu.selectedId()).toBe('custom-picker');
        await menu.press('ArrowUp');
        await menu.press('ArrowUp');
        expect(menu.selectedId()).toBe('blue');
        await menu.hook.unmount();
    });

    it('opens a submenu with ArrowRight or Enter and goes back with ArrowLeft', async () => {
        const menu = await renderMenu([{ id: 'color', title: 'Color', hasSubmenu: true }, { id: 'rename', title: 'Rename' }]);
        const onOpenSubmenu = vi.fn();
        const onBack = vi.fn();

        const activatedByEnter = await menu.press('Enter', { onOpenSubmenu, onBack });
        await menu.press('ArrowRight', { onOpenSubmenu, onBack });
        await menu.press('ArrowLeft', { onOpenSubmenu, onBack });

        expect(activatedByEnter).not.toHaveBeenCalled();
        expect(onOpenSubmenu).toHaveBeenCalledTimes(2);
        expect(onOpenSubmenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'color' }));
        expect(onBack).toHaveBeenCalledOnce();
        await menu.hook.unmount();
    });
});
