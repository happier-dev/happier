import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const settingsState: Record<string, any> = {
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: false,
};

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    AppState: {
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
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
                accent: {
                    blue: '#00f',
                    orange: '#f90',
                    indigo: '#6366f1',
                },
                surface: '#fff',
                text: '#111',
                textSecondary: '#666',
                success: '#0a0',
                divider: '#ddd',
                input: {
                    background: '#f3f3f3',
                    text: '#111',
                    placeholder: '#999',
                },
                groupped: {
                    sectionTitle: '#444',
                    background: '#f7f7f7',
                },
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    colors: {
                        accent: {
                            blue: '#00f',
                            orange: '#f90',
                            indigo: '#6366f1',
                        },
                        surface: '#fff',
                        text: '#111',
                        textSecondary: '#666',
                        success: '#0a0',
                        divider: '#ddd',
                        input: {
                            background: '#f3f3f3',
                            text: '#111',
                            placeholder: '#999',
                        },
                        groupped: {
                            sectionTitle: '#444',
                            background: '#f7f7f7',
                        },
                    },
                }, {})
                : input,
    },
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

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
    LlmTaskRunnerConfigV1BackendModelPicker: (props: any) =>
        React.createElement('LlmTaskRunnerConfigV1BackendModelPicker', props),
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
                    ? React.createElement(React.Fragment, null, props.trigger({ open: false, toggle: () => {} }))
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

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => [
        key in settingsState ? settingsState[key] : null,
        (next: any) => {
            settingsState[key] = next;
        },
    ],
    useLocalSettingMutable: (key: string) => [
        key in settingsState ? settingsState[key] : null,
        (next: any) => {
            settingsState[key] = next;
        },
    ],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        return null;
    },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
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

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('Session settings (Permissions entry)', () => {
    it('does not render a permissions entry or inline permission controls on the root session settings screen', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);

        const permissionsLink = items.find((item: any) => item?.props?.title === 'settings.permissions');
        expect(permissionsLink).toBeFalsy();

        expect(items.some((item: any) => item?.props?.title === 'settingsSession.defaultPermissions.applyPermissionChangesTitle')).toBe(false);
    });
});
