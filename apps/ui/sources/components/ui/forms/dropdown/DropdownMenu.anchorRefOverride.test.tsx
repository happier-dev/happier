import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, null),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => React.createElement('SelectableMenuResults', props),
}));

vi.mock('@/components/ui/forms/dropdown/useSelectableMenu', () => ({
    CREATE_ITEM_ID: '__create__',
    useSelectableMenu: () => ({
        searchQuery: '',
        selectedIndex: 0,
        filteredCategories: [],
        inputRef: { current: null },
        handleSearchChange: vi.fn(),
        handleKeyPress: vi.fn(),
        setSelectedIndex: vi.fn(),
    }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: any) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement', () => ({
    renderDropdownItemTriggerRightElement: () => null,
}));

describe('DropdownMenu (anchorRef override)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('passes anchorRef to Popover when provided', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const anchorRef = React.createRef<any>();

        const screen = await renderScreen(
            <DropdownMenu
                open={true}
                onOpenChange={() => {}}
                items={[]}
                onSelect={() => {}}
                popoverAnchorRef={anchorRef}
            />,
        );

        const popover = screen.findByType('Popover' as any) as any;
        expect(popover.props.anchorRef).toBe(anchorRef);
    });
});
