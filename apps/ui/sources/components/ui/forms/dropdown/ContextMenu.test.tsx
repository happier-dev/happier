import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

const dropdownMenuSpy = vi.fn();

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        dropdownMenuSpy(props);
        return React.createElement('DropdownMenu', props);
    },
}));

describe('ContextMenu', () => {
    it('passes context-menu defaults to DropdownMenu', async () => {
        const { ContextMenu } = await import('./ContextMenu');

        const anchorRef = { current: {} } as any;

        await renderScreen(React.createElement(ContextMenu, {
            open: true,
            onOpenChange: () => {},
            anchorRef,
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
        } as any));

        expect(dropdownMenuSpy).toHaveBeenCalled();
        const props = dropdownMenuSpy.mock.calls[0]?.[0];
        expect(props).toBeTruthy();
        expect(props.popoverAnchorRef).toBe(anchorRef);
        expect(props.popoverAnchorAlign).toBe('center');
        expect(props.popoverAnchorAlignVertical).toBe('center');
        expect(props.overlayArrow).toBe(true);
        expect(props.allowEmptySelection).toBe(true);
    });
});
