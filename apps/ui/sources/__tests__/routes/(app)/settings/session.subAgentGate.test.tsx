import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { settingsDefaults } from '@/sync/domains/settings/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionSettingsState = Pick<Settings, 'sessionsRightPaneDefaultOpen' | 'uiMultiPanePanelsEnabled'>;

const settingsState: Partial<SessionSettingsState> = {
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: false,
};
const localSettingsState: LocalSettings = { ...localSettingsDefaults };
let executionRunsEnabled = false;

function isSessionSettingsKey(key: keyof Settings): key is keyof SessionSettingsState {
    return key === 'sessionsRightPaneDefaultOpen' || key === 'uiMultiPanePanelsEnabled';
}

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

vi.mock('react-native-unistyles', async () => await createUnistylesMock());

vi.mock('expo-router', () => createExpoRouterMock().module);

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
        useSettingMutable: <K extends keyof Settings>(key: K) => [
            (isSessionSettingsKey(key) ? settingsState[key] : settingsDefaults[key]) as Settings[K],
            (next: Settings[K]) => {
                if (isSessionSettingsKey(key)) {
                    settingsState[key] = next;
                }
            },
        ] as const,
        useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
            localSettingsState[key],
            (next: LocalSettings[K]) => {
                localSettingsState[key] = next;
            },
        ] as const,
        useSetting: <K extends keyof Settings>(key: K) => {
            if (key === 'recentMachinePaths') return [];
            if (isSessionSettingsKey(key)) {
                return settingsState[key] as Settings[K];
            }
            return settingsDefaults[key];
        },
    },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
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
    useFeatureEnabled: () => executionRunsEnabled,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

describe('Session settings (Sub-agent gate)', () => {
    it('does not render the Sub-agent section when execution runs are disabled', async () => {
        executionRunsEnabled = false;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });

    it('does not render the Subagents shortcut when execution runs are enabled', async () => {
        executionRunsEnabled = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });
});
