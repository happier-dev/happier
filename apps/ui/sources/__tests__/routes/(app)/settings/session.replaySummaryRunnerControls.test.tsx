import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The shared mock answers a parameterized key with `{ key, params }`, a shape
 * the real `t` can never return, and this screen renders one such key as a
 * child. Serialize it for this suite rather than teaching the whole tree a new
 * mock shape.
 */
const serializingTextModule = async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
};

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        });
    },
    featureEnabled: () => executionRunsEnabledState.enabled,
    textModule: serializingTextModule,
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
    sessionSettingsEntryState.options.textModule = serializingTextModule;
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

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));

        expect(screen.findAllByTestId('settings-session-replay-maxSeedChars-input')).toHaveLength(1);
    });

    it('renders summary runner inputs when replay is enabled, strategy is summary_plus_recent, and execution runs are enabled', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));
        const summaryRunnerPickers = screen.findAllByType('LlmTaskRunnerConfigV1BackendModelPicker' as any);

        expect(summaryRunnerPickers).toHaveLength(1);
        expect(summaryRunnerPickers[0]?.props?.backendTestID).toBe('settings-session-replay-summaryRunner-backend');
        expect(summaryRunnerPickers[0]?.props?.modelTestID).toBe('settings-session-replay-summaryRunner-model');
    });

    it('does not render summary runner inputs when execution runs are disabled', async () => {
        executionRunsEnabledState.enabled = false;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionResumeSettingsScreen));
        const summaryRunnerPickers = screen.findAllByType('LlmTaskRunnerConfigV1BackendModelPicker' as any);

        expect(summaryRunnerPickers).toHaveLength(0);
    });
});
