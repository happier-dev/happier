import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {
    sessionReplayEnabled: true,
    sessionReplayStrategy: 'summary_plus_recent',
    sessionReplayRecentMessagesCount: 100,
    sessionReplayMaxSeedChars: 50_000,
    sessionReplaySummaryRunnerV1: null,
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: false,
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

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
            ? React.createElement(React.Fragment, null, props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {}, selectedItem: null }))
            : props.itemTrigger
                ? React.createElement('Item', { ...(props.itemTrigger.itemProps ?? {}) })
                : null,
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => await createStorageModuleMock({
    importOriginal,
    overrides: {
        useSettingMutable: (key: string) => {
            return [
                key in settingsState ? settingsState[key] : null,
                (next: any) => {
                    settingsState[key] = next;
                },
            ];
        },
        useLocalSettingMutable: (key: string) => {
            return [
                key in settingsState ? settingsState[key] : null,
                (next: any) => {
                    settingsState[key] = next;
                },
            ];
        },
        useSetting: (key: string) => {
            if (key === 'recentMachinePaths') return [];
            return null;
        },
    },
}));

const executionRunsEnabledState = { enabled: true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => executionRunsEnabledState.enabled,
}));

vi.mock('react-native-unistyles', async () => await createUnistylesMock());

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
}));

beforeEach(() => {
    executionRunsEnabledState.enabled = true;
    settingsState.sessionReplayEnabled = true;
    settingsState.sessionReplayStrategy = 'summary_plus_recent';
    settingsState.sessionReplayRecentMessagesCount = 100;
    settingsState.sessionReplayMaxSeedChars = 50_000;
    settingsState.sessionReplaySummaryRunnerV1 = null;
});

afterEach(() => {
    executionRunsEnabledState.enabled = true;
});

describe('Session settings (Replay summary runner controls)', () => {
    it('renders a max seed chars input when replay is enabled', async () => {
        executionRunsEnabledState.enabled = true;
        settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.root.findAllByType('Text' as any).map((n: any) => n?.props?.children).flat();

        expect(texts).toContain('settingsSession.replayResume.maxSeedCharsTitle');
        expect(screen.findAllByTestId('settings-session-replay-maxSeedChars-input')).toHaveLength(1);
    });

    it('renders summary runner inputs when replay is enabled, strategy is summary_plus_recent, and execution runs are enabled', async () => {
        executionRunsEnabledState.enabled = true;
        settingsState.sessionReplayEnabled = true;
        settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.root.findAllByType('Text' as any).map((n: any) => n?.props?.children).flat();

        expect(texts).toContain('settingsSession.replayResume.summaryRunner.title');
        expect(texts).toContain('settingsSession.replayResume.summaryRunner.backendTitle');
        expect(texts).toContain('settingsSession.replayResume.summaryRunner.modelTitle');

        expect(screen.findAllByTestId('settings-session-replay-summaryRunner-backend')).toHaveLength(1);
        expect(screen.findAllByTestId('settings-session-replay-summaryRunner-model')).toHaveLength(1);
    });

    it('does not render summary runner inputs when execution runs are disabled', async () => {
        executionRunsEnabledState.enabled = false;
        settingsState.sessionReplayEnabled = true;
        settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.root.findAllByType('Text' as any).map((n: any) => n?.props?.children).flat();

        expect(texts).not.toContain('settingsSession.replayResume.summaryRunner.title');
    });
});
