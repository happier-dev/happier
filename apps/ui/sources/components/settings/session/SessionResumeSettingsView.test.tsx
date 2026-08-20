import * as React from 'react';
import { HAPPIER_REPLAY_SEED_MAX_CHARS, HAPPIER_REPLAY_SEED_MIN_CHARS } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';

import {
    installSessionSettingsCommonModuleMocks,
} from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState = vi.hoisted(() => ({
    values: {
        sessionReplayEnabled: true,
        sessionReplayStrategy: 'summary_plus_recent',
        sessionReplayRecentMessagesCount: 100,
        sessionReplayMaxSeedChars: 50_000,
        sessionReplaySummaryRunnerV1: null,
    } as Record<string, unknown>,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installSessionSettingsCommonModuleMocks({
    storage: async (importOriginal) => createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: ((key: string) => {
                const [value, setValue] = React.useState(() => settingsState.values[key] ?? null);

                return [
                    value,
                    (next: unknown) => {
                        setValue((current) => {
                            const resolved = typeof next === 'function'
                                ? (next as (value: unknown) => unknown)(current)
                                : next;
                            settingsState.values[key] = resolved;
                            return resolved;
                        });
                    },
                ] as const;
            }) as unknown as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
        },
    }),
});

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: React.forwardRef((props: any, _ref) => React.createElement('ItemList', props, props.children)),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null, props.children ?? null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
    LlmTaskRunnerConfigV1BackendModelPicker: (props: any) =>
        React.createElement('LlmTaskRunnerConfigV1BackendModelPicker', props),
}));

describe('SessionResumeSettingsView', () => {
    beforeEach(() => {
        settingsState.values = {
            sessionReplayEnabled: true,
            sessionReplayStrategy: 'summary_plus_recent',
            sessionReplayRecentMessagesCount: 100,
            sessionReplayMaxSeedChars: 50_000,
            sessionReplaySummaryRunnerV1: null,
        };
    });

    // The entering half of the defect. A budget below the floor was accepted
    // verbatim and produced no seed at all, so the screen must refuse to
    // produce one rather than storing what was typed.
    it('keeps the raw max seed chars draft while typing and clamps to the floor when committed', async () => {
        const mod = await import('./SessionResumeSettingsView');
        const SessionResumeSettingsView = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionResumeSettingsView));
        const input = screen.findByTestId('settings-session-replay-maxSeedChars-input')!;

        act(() => {
            screen.changeTextByTestId('settings-session-replay-maxSeedChars-input', '3');
        });

        expect(input.props.value).toBe('3');
        expect(settingsState.values.sessionReplayMaxSeedChars).toBe(50_000);

        act(() => {
            input.props.onBlur?.();
        });

        expect(settingsState.values.sessionReplayMaxSeedChars).toBe(HAPPIER_REPLAY_SEED_MIN_CHARS);
        expect(input.props.value).toBe(String(HAPPIER_REPLAY_SEED_MIN_CHARS));
    });

    it.each([
        { typed: '500', stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: String(HAPPIER_REPLAY_SEED_MIN_CHARS - 1), stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: String(HAPPIER_REPLAY_SEED_MIN_CHARS), stored: HAPPIER_REPLAY_SEED_MIN_CHARS },
        { typed: '999999', stored: HAPPIER_REPLAY_SEED_MAX_CHARS },
    ])('commits a typed budget of $typed as $stored', async ({ typed, stored }) => {
        const mod = await import('./SessionResumeSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        act(() => {
            screen.changeTextByTestId('settings-session-replay-maxSeedChars-input', typed);
        });
        act(() => {
            screen.findByTestId('settings-session-replay-maxSeedChars-input')!.props.onBlur?.();
        });

        expect(settingsState.values.sessionReplayMaxSeedChars).toBe(stored);
    });

    // Both live replay routes pass `recentMessagesCount: null` on purpose: the
    // seed is bounded by CHARACTERS. Only the compatibility-only
    // `continueWithReplay` ingress reads the count, so the control could not
    // change any outcome a user can reach. The stored key stays.
    it('does not render the recent-messages control that cannot affect any outcome', async () => {
        const mod = await import('./SessionResumeSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.getTextContent()).not.toContain('settingsSession.replayResume.recentMessagesTitle');
        expect(settingsState.values.sessionReplayRecentMessagesCount).toBe(100);
    });

    // A user who picks "Summary + recent" and never opens the backend picker
    // silently receives recent-only, because the fork resolver forwards the
    // runner only when one is set. The screen has to say so.
    it('discloses the unmet summary-model requirement', async () => {
        const mod = await import('./SessionResumeSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeTruthy();
    });

    it('stops disclosing once a summary model is configured', async () => {
        settingsState.values.sessionReplaySummaryRunnerV1 = { v: 1, backendTargetKey: 'agent:claude' };

        const mod = await import('./SessionResumeSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });

    it('says nothing about a summary model under the recent-messages strategy', async () => {
        settingsState.values.sessionReplayStrategy = 'recent_messages';

        const mod = await import('./SessionResumeSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findByTestId('settings-session-replay-summaryRunner-requirement')).toBeNull();
    });
});
