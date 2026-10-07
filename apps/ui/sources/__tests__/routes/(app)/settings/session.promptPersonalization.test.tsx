import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks({
    featureEnabled: (featureId) => featureId === 'sessions.usageLimitRecovery',
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

type SettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

/** The resume-prompt segmented row: `Item` is a host element here, its segmented control is the `rightElement`. */
function resumePromptChoice(screen: SettingsScreen) {
    const row = screen.findAll((node) => (
        (node.type as unknown) === 'Item' && node.props?.testID === 'settings-session-usage-limit-recovery-resume-prompt'
    ))[0];
    if (!row) throw new Error('Missing the resume prompt choice');
    return row;
}

describe('Session settings (prompt personalization)', () => {
    it('renders prompt personalization controls on the root session settings screen', async () => {
        sessionSettingsEntryState.settingsState.codingPromptBehaviorV1 = {
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
        };
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = {
            v: 1,
            mode: 'ask',
        };

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType('ItemGroup' as any).map((group) => group.props.title);
        expect(groupTitles).toContain('settingsSession.rootGroups.agentPersonalization.title');
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')).toBeTruthy();

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const titleDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle');
        expect(titleDropdown).toBeTruthy();
        expect(titleDropdown?.props?.selectedId).toBe('ongoing');
        expect(titleDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['disabled', 'initial', 'ongoing']);

        titleDropdown!.props.onSelect('initial');
        expect(sessionSettingsEntryState.settingsState.codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'initial',
            responseOptions: 'agent',
        });
    });

    it('updates the usage limit recovery resume prompt mode', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery';
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = {
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'standard',
        };

        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const resumePrompt = resumePromptChoice(screen);
        expect(resumePrompt.props.title).toBe('settingsSession.usageLimitRecovery.resumePromptTitle');
        expect(resumePrompt.props.rightElement.props.activeTabId).toBe('standard');
        expect(resumePrompt.props.rightElement.props.tabs.map((tab: any) => tab.id)).toEqual(['standard', 'custom', 'off']);

        await act(async () => {
            resumePrompt.props.rightElement.props.onSelectTab('off');
        });

        expect(sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'off',
        });
    });

    it('selects the custom resume prompt mode while preserving the saved custom text', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery';
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = {
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'standard',
            customResumePrompt: 'Pick the task back up.',
        };

        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        await act(async () => {
            resumePromptChoice(screen).props.rightElement.props.onSelectTab('custom');
        });

        expect(sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Pick the task back up.',
        });
    });

    it('shows the inline custom prompt input when custom mode is selected and commits trimmed text', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery';
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = {
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
        };

        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const inputRow = screen.findRowByTitle('settingsSession.usageLimitRecovery.customResumePromptTitle');
        expect(inputRow).toBeTruthy();
        // `Item` is a host element here, so the inline field is the row's `rightElement`.
        const input = (inputRow as any)?.props?.rightElement;
        expect(input?.props?.placeholder).toBe('settingsSession.usageLimitRecovery.customResumePromptPlaceholder');
        expect(input?.props?.maxLength).toBeUndefined();

        await act(async () => {
            input.props.onChangeText('  Resume exactly where you stopped.  ');
        });
        // The draft is local state; commit happens on blur/submit. Re-grab the row after re-render.
        const updatedInput = (screen.findRowByTitle('settingsSession.usageLimitRecovery.customResumePromptTitle') as any)?.props?.rightElement;
        await act(async () => {
            updatedInput.props.onBlur();
        });

        expect(sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Resume exactly where you stopped.',
        });
    });

    it('hides the inline custom prompt input when custom mode is not selected', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery';
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = {
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'standard',
        };

        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.usageLimitRecovery.customResumePromptTitle')).toBeFalsy();
    });
});
