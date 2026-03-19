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
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
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

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
    LlmTaskRunnerConfigV1BackendModelPicker: 'LlmTaskRunnerConfigV1BackendModelPicker',
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
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
    useSetting: () => null,
}));

vi.mock('./sessionI18n', () => ({
    getPermissionApplyTimingSubtitleKey: () => 'x',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: {
                    blue: '#00f',
                    orange: '#f80',
                    indigo: '#80f',
                    green: '#0f0',
                },
                input: {
                    placeholder: '#999',
                },
                groupped: {
                    sectionTitle: '#666',
                },
            },
        },
    }),
    StyleSheet: {
        create: () => new Proxy({}, { get: () => ({}) }),
    },
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('Session settings (Handoff entry)', () => {
    it('includes a handoff entry that routes to /settings/session/handoff', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const items = tree.root.findAllByType('Item' as any);
        const handoffItem = items.find((item: any) => item?.props?.title === 'settingsSession.handoff.title');
        expect(handoffItem).toBeTruthy();

        await act(async () => {
            handoffItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/handoff');
    });
});
