import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { placeholder: '#999', background: '#fff' },
                text: '#111',
                textSecondary: '#666',
                divider: '#e5e5e5',
            },
        },
    }),
    StyleSheet: { create: (v: any) => v, absoluteFillObject: {} },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [null, vi.fn()],
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => 'default',
    getPermissionModeOptionsForAgentType: () => [],
}));

vi.mock('./sessionI18n', () => ({
    getPermissionApplyTimingSubtitleKey: () => 'x',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

describe('Session settings (Sub-agent gate)', () => {
    it('does not render the Sub-agent section when execution runs are disabled', async () => {
        const mod = await import('./session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const subAgentItem = items.find((item: any) => item?.props?.title === 'Guidance rules');
        expect(subAgentItem).toBeFalsy();
    });
});

