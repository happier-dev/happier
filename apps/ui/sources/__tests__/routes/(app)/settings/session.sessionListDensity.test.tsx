import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListDensity = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            TextInput: 'TextInput',
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('react-native-unistyles', async () => await createUnistylesMock());

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

vi.mock('@/text', () => createTextModuleMock());

vi.mock('@/modal', () => createModalModuleMock().module);

vi.mock('@/sync/domains/state/storage', async (importOriginal) => await createStorageModuleMock({
    importOriginal,
    overrides: {
        useSettingMutable: ((key: string) => {
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
        }) as any,
        useLocalSettingMutable: ((key: string) => {
            if (key === 'sessionsRightPaneDefaultOpen') return [false, vi.fn()];
            if (key === 'uiMultiPanePanelsEnabled') return [true, vi.fn()];
            return [null, vi.fn()];
        }) as any,
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

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
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
