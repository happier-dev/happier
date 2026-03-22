import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        agentInputEnterToSend: false,
        agentInputHistoryScope: 'perSession',
        sessionMessageSendMode: 'agent_queue',
        sessionBusySteerSendPolicy: 'steer_immediately',
        terminalConnectLegacySecretExportEnabled: false,
        sessionReplayEnabled: false,
        sessionReplayStrategy: 'recent_messages',
        sessionReplayRecentMessagesCount: 100,
        sessionUseTmux: false,
        sessionTmuxSessionName: null,
        sessionTmuxIsolated: false,
        sessionTmuxTmpDir: null,
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: true,
    } as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                useWindowDimensions: () => ({ width: 1280, height: 800 }),
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
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
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
    LlmTaskRunnerConfigV1BackendModelPicker: 'LlmTaskRunnerConfigV1BackendModelPicker',
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
            useSettingMutable: ((key: string) => [key in shared.settingsState ? shared.settingsState[key] : null, vi.fn()]) as any,
            useLocalSettingMutable: ((key: string) => [key in shared.settingsState ? shared.settingsState[key] : null, vi.fn()]) as any,
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

afterEach(() => {
    standardCleanup();
});

describe('Session settings (web features moved)', () => {
    it('shows Enter-to-send and Message history inside Session settings (web)', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const dropdownTriggerTitles = dropdowns
            .map((dropdown) => dropdown.props?.itemTrigger?.title)
            .filter((title): title is string => typeof title === 'string');

        expect(titles).toContain('settingsFeatures.enterToSend');
        expect([...titles, ...dropdownTriggerTitles]).toContain('settingsFeatures.historyScope');

        const historyDropdown = dropdowns.find((dropdown) => {
            const ids = (dropdown.props.items ?? []).map((item: { id?: string }) => item.id);
            return ids.includes('global') && ids.includes('perSession');
        });

        expect(historyDropdown).toBeTruthy();
    });
});
