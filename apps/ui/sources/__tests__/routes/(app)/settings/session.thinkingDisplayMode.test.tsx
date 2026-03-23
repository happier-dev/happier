import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    setThinkingDisplayMode: vi.fn(),
    setThinkingInlinePresentation: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                TextInput: 'TextInput',
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) =>
        React.createElement(
            'DropdownMenu',
            props,
            props.itemTrigger
                ? React.createElement('Item', {
                    title: props.itemTrigger.title,
                    onPress: () => props.onOpenChange?.(!props.open),
                    disabled: props.itemTrigger?.itemProps?.disabled,
                })
                : (typeof props.trigger === 'function'
                    ? props.trigger({
                        open: props.open,
                        toggle: () => props.onOpenChange?.(!props.open),
                        openMenu: () => props.onOpenChange?.(true),
                        closeMenu: () => props.onOpenChange?.(false),
                        selectedItem: null,
                    })
                    : null),
        ),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: (key: string) => {
                if (key === 'sessionThinkingDisplayMode') return ['inline', shared.setThinkingDisplayMode];
                if (key === 'sessionThinkingInlinePresentation') return ['summary', shared.setThinkingInlinePresentation];
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

afterEach(() => {
    standardCleanup();
    shared.setThinkingDisplayMode.mockClear();
    shared.setThinkingInlinePresentation.mockClear();
});

describe('Transcript settings (thinking display mode)', () => {
    it('renders a dropdown and updates session thinking mode + inline presentation', async () => {
        const mod = await import('@/app/(app)/settings/session/transcript');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.thinking.displayModeTitle')).toBeTruthy();

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        expect(dropdowns.length).toBeGreaterThan(0);

        const thinkingDropdown = dropdowns.find((dropdown: any) => dropdown?.props?.selectedId === 'inline_summary');
        expect(thinkingDropdown).toBeTruthy();

        await act(async () => {
            thinkingDropdown!.props.onSelect('inline_full');
        });

        expect(shared.setThinkingDisplayMode).toHaveBeenCalledWith('inline');
        expect(shared.setThinkingInlinePresentation).toHaveBeenCalledWith('full');
    });
});
