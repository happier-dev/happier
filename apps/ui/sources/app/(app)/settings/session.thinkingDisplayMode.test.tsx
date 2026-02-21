import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

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
                    ? props.trigger({ open: props.open, toggle: () => props.onOpenChange?.(!props.open), openMenu: () => props.onOpenChange?.(true), closeMenu: () => props.onOpenChange?.(false), selectedItem: null })
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const setThinkingDisplayMode = vi.fn();
vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'sessionThinkingDisplayMode') return ['inline', setThinkingDisplayMode];
        return [null, vi.fn()];
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (key: string) => key === 'messages.thinkingVisibility',
}));

afterEach(() => {
    setThinkingDisplayMode.mockClear();
});

describe('Session settings (thinking display mode)', () => {
    it('renders a dropdown and updates sessionThinkingDisplayMode', async () => {
        const mod = await import('./session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const triggerItem = items.find((item: any) => item?.props?.title === 'settingsSession.thinking.displayModeTitle');
        expect(triggerItem).toBeTruthy();

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        expect(dropdowns.length).toBeGreaterThan(0);

        const thinkingDropdown = dropdowns.find((d: any) => d?.props?.selectedId === 'inline');
        expect(thinkingDropdown).toBeTruthy();

        await act(async () => {
            thinkingDropdown!.props.onSelect('tool');
        });

        expect(setThinkingDisplayMode).toHaveBeenCalledWith('tool');
    });
});
