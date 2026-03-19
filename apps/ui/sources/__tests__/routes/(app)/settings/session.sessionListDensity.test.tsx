import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListDensity = vi.fn();

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
                : null,
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
    useSettingMutable: (key: string) => {
        if (key === 'sessionTagsEnabled') return [true, vi.fn()];
        if (key === 'sessionListDensity') return ['cozy', setSessionListDensity];
        if (key === 'hideInactiveSessions') return [false, vi.fn()];
        if (key === 'sessionListActiveGroupingV1') return ['project', vi.fn()];
        if (key === 'sessionListInactiveGroupingV1') return ['date', vi.fn()];
        if (key === 'agentInputActionBarLayout') return ['auto', vi.fn()];
        if (key === 'agentInputChipDensity') return ['auto', vi.fn()];
        if (key === 'alwaysShowContextSize') return [false, vi.fn()];
        if (key === 'sessionUseTmux') return [false, vi.fn()];
        if (key === 'sessionTmuxSessionName') return ['happy', vi.fn()];
        if (key === 'sessionTmuxIsolated') return [true, vi.fn()];
        if (key === 'sessionTmuxTmpDir') return [null, vi.fn()];
        if (key === 'sessionMessageSendMode') return ['agent_queue', vi.fn()];
        if (key === 'sessionBusySteerSendPolicy') return ['steer_immediately', vi.fn()];
        if (key === 'agentInputEnterToSend') return [true, vi.fn()];
        if (key === 'agentInputHistoryScope') return ['perSession', vi.fn()];
        if (key === 'terminalConnectLegacySecretExportEnabled') return [false, vi.fn()];
        if (key === 'sessionReplayEnabled') return [false, vi.fn()];
        if (key === 'sessionReplayStrategy') return ['recent_messages', vi.fn()];
        if (key === 'sessionReplayRecentMessagesCount') return [250, vi.fn()];
        if (key === 'sessionReplayMaxSeedChars') return [120000, vi.fn()];
        if (key === 'sessionReplaySummaryRunnerV1') return [null, vi.fn()];
        return [null, vi.fn()];
    },
    useLocalSettingMutable: (key: string) => {
        if (key === 'sessionsRightPaneDefaultOpen') return [false, vi.fn()];
        if (key === 'uiMultiPanePanelsEnabled') return [true, vi.fn()];
        return [null, vi.fn()];
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

afterEach(() => {
    setSessionListDensity.mockClear();
});

describe('Session settings session list density', () => {
    it('defaults to the cozy density option and updates only the canonical density setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const densityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.sessionListDensity.title');
        expect(densityDropdown).toBeTruthy();
        expect(densityDropdown?.props?.selectedId).toBe('cozy');

        const itemIds = densityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['detailed', 'cozy', 'narrow']);

        await act(async () => {
            densityDropdown!.props.onSelect('cozy');
        });

        expect(setSessionListDensity).toHaveBeenCalledWith('cozy');
    });
});
