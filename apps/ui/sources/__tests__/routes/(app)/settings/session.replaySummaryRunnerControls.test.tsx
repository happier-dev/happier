import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPPIER_REPLAY_SEED_MAX_CHARS, HAPPIER_REPLAY_SEED_MIN_CHARS } from '@happier-dev/protocol';
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

describe('Session resume settings (Replay summary runner controls)', () => {
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

    // The entering half of the defect. A budget below the floor was accepted
    // verbatim and produced no seed at all, so the screen must refuse to
    // produce one rather than storing what was typed.
    it.each([
        { typed: '500', stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: String(HAPPIER_REPLAY_SEED_MIN_CHARS - 1), stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: String(HAPPIER_REPLAY_SEED_MIN_CHARS), stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: '999999', stored: HAPPIER_REPLAY_SEED_MAX_CHARS },
    ])('commits a typed budget of $typed as $stored', async ({ typed, stored }) => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        await act(async () => {
            screen.findByTestId('settings-session-replay-maxSeedChars-input')!.props.onChangeText(typed);
        });
        await act(async () => {
            screen.findByTestId('settings-session-replay-maxSeedChars-input')!.props.onBlur();
        });

        expect(sessionSettingsEntryState.settingsState.sessionReplayMaxSeedChars).toBe(stored);
    });

    // Both live replay routes pass `recentMessagesCount: null` on purpose: the
    // seed is bounded by CHARACTERS. Only the compatibility-only
    // `continueWithReplay` ingress reads the count, so the control could not
    // change any outcome a user can reach. The stored key stays.
    it('states the budget bounds it will clamp to, and names the field programmatically', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        const expectedRange =
            `settingsSession.replayResume.maxSeedCharsRange(min=${HAPPIER_REPLAY_SEED_MIN_CHARS},max=${HAPPIER_REPLAY_SEED_MAX_CHARS})`;
        const input = screen.findByTestId('settings-session-replay-maxSeedChars-input');
        // A field that silently moves an out-of-range number to the nearest
        // limit has to name its bounds, and the visible label is not attached
        // to it.
        expect(input?.props.accessibilityLabel).toBe('settingsSession.replayResume.maxSeedCharsTitle');
        expect(input?.props.accessibilityHint).toBe(expectedRange);
        expect(screen.findByTestId('settings-session-replay-maxSeedChars-range')?.props.children).toBe(expectedRange);
    });

    it('does not render the recent-messages control that cannot affect any outcome', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;

        const mod = await import('@/app/(app)/settings/session/resume');
        const screen = await renderScreen(React.createElement(mod.default));

        expect(screen.getTextContent()).not.toContain('settingsSession.replayResume.recentMessagesTitle');
        expect(screen.findAllByProps({ placeholder: 'settingsSession.replayResume.recentMessagesPlaceholder' })).toHaveLength(0);
    });

    it('leaves the stored recent-messages preference untouched while the control is hidden', async () => {
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayRecentMessagesCount = 100;

        const mod = await import('@/app/(app)/settings/session/resume');
        await renderScreen(React.createElement(mod.default));

        expect(sessionSettingsEntryState.settingsState.sessionReplayRecentMessagesCount).toBe(100);
    });
});

// A user who picks "Summary + recent" and never opens the backend picker
// silently receives recent-only, because the fork resolver forwards the runner
// only when one is set. The screen has to say so.
describe('Session resume settings (summary strategy discloses its requirement)', () => {
    async function renderResume() {
        const mod = await import('@/app/(app)/settings/session/resume');
        return renderScreen(React.createElement(mod.default));
    }

    it('discloses the unmet summary-model requirement when the strategy is selected', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
        sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = null;

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeTruthy();
    });

    it('stops disclosing once a summary model is configured', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';
        sessionSettingsEntryState.settingsState.sessionReplaySummaryRunnerV1 = { v: 1, backendTargetKey: 'agent:claude' };

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });

    // Execution runs off is the worse case: the picker is not even rendered, so
    // without this the screen offers a strategy with no way to make it work.
    it('discloses that the strategy cannot run at all when execution runs are off', async () => {
        executionRunsEnabledState.enabled = false;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'summary_plus_recent';

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeTruthy();
    });

    it('says nothing about a summary model under the recent-messages strategy', async () => {
        executionRunsEnabledState.enabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayEnabled = true;
        sessionSettingsEntryState.settingsState.sessionReplayStrategy = 'recent_messages';

        const screen = await renderResume();

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });
});
