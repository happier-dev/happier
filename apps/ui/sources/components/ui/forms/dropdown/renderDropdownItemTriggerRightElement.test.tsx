import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';

installDropdownCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key === 'common.choose' ? 'Choose…' : key });
    },
});
vi.unmock('@/components/ui/icons/Icon');

describe('renderDropdownItemTriggerRightElement', () => {
    it('renders the closed-trigger chevron directly instead of wrapping it in Text', async () => {
        const { renderDropdownItemTriggerRightElement } = await import('./renderDropdownItemTriggerRightElement');
        const { Icon } = await import('@/components/ui/icons/Icon');

        const node = renderDropdownItemTriggerRightElement({
            detail: null,
            open: false,
            detailColor: '#666',
            chevronColor: '#999',
        });

        expect(React.isValidElement(node)).toBe(true);
        // The chevron is drawn by the icon seam now; the contract worth asserting is that it is
        // returned as a bare element rather than wrapped in a Text node.
        expect((node as React.ReactElement).type).toBe(Icon);
    });

    it('shows a placeholder in an empty page field instead of a blank box', async () => {
        const { renderDropdownItemTriggerRightElement } = await import('./renderDropdownItemTriggerRightElement');

        const node = renderDropdownItemTriggerRightElement({
            detail: null,
            open: false,
            detailColor: '#666',
            chevronColor: '#999',
            field: { borderColor: '#ccc', backgroundColor: '#fff', valueColor: '#111', placeholderColor: '#aaa' },
        });

        const screen = await renderScreen(<>{node}</>);
        const valueText = screen.tree.findAll((child) => child.type === 'Text' && child.props.children === 'Choose…');
        expect(valueText).toHaveLength(1);
        expect(flattenTestStyle(valueText[0]!.props.style).color).toBe('#aaa');
    });
});
