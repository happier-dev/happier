import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

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
    useRouter: () => ({ push: routerPushSpy }),
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
        typeof props.trigger === 'function'
            ? React.createElement(React.Fragment, null, props.trigger({ open: false, toggle: () => {} }))
            : null,
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

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('Session settings (Tool rendering entry)', () => {
    it('routes to the tool rendering sub-screen and no longer renders tool detail controls inline', async () => {
        const mod = await import('./session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);

        const toolRenderingLink = items.find((item: any) => item?.props?.title === 'settingsSession.toolRendering.title');
        expect(toolRenderingLink).toBeTruthy();

        const legacyInlineToolTitles = new Set([
            'settingsSession.toolRendering.defaultToolDetailLevelTitle',
            'settingsSession.toolRendering.localControlDefaultTitle',
            'settingsSession.toolRendering.showDebugByDefaultTitle',
            'Bash',
        ]);
        for (const title of legacyInlineToolTitles) {
            expect(items.some((item: any) => item?.props?.title === title)).toBe(false);
        }

        await act(async () => {
            toolRenderingLink!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/tool-rendering');
    });
});

