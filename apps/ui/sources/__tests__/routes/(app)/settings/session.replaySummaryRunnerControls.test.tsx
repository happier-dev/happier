import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        });
    },
    featureEnabled: () => executionRunsEnabledState.enabled,
});

const executionRunsEnabledState = { enabled: true };

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
    resetSessionSettingsEntryState();
    executionRunsEnabledState.enabled = true;
    sessionSettingsEntryState.options.featureEnabled = () => executionRunsEnabledState.enabled;
    sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
    sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
    sessionSettingsEntryState.settingsState.sessionReplayRecentMessagesCount = 100;
    sessionSettingsEntryState.settingsState.sessionReplayMaxSeedChars = 50_000;
    sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = null;
});

afterEach(() => {
    executionRunsEnabledState.enabled = true;
    resetSessionSettingsEntryState();
});

describe('Session settings (Replay summary runner controls)', () => {
    it('renders a max seed chars input when replay is enabled', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.getTextContent();

        expect(texts).toContain('settingsSession.replayResume.maxSeedCharsTitle');
        expect(screen.findAllByTestId('settings-session-replay-maxSeedChars-input')).toHaveLength(1);
    });

    it('renders summary runner inputs when replay is enabled, strategy is summary_plus_recent, and execution runs are enabled', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.getTextContent();
        const summaryRunnerPickers = screen.findAllByType('LlmTaskRunnerConfigV1BackendModelPicker' as any);

        expect(texts).toContain('settingsSession.replayResume.summaryRunner.title');
        expect(summaryRunnerPickers).toHaveLength(1);
        expect(summaryRunnerPickers[0]?.props?.backendTestID).toBe('settings-session-replay-summaryRunner-backend');
        expect(summaryRunnerPickers[0]?.props?.modelTestID).toBe('settings-session-replay-summaryRunner-model');
    });

    it('does not render summary runner inputs when execution runs are disabled', async () => {
        executionRunsEnabledState.enabled = false;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const texts = screen.getTextContent();

        expect(texts).not.toContain('settingsSession.replayResume.summaryRunner.title');
    });
});
