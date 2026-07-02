import * as React from 'react';
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

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const resumePromptDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.usageLimitRecovery.resumePromptTitle');
        expect(resumePromptDropdown).toBeTruthy();
        expect(resumePromptDropdown?.props?.selectedId).toBe('standard');
        expect(resumePromptDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['standard', 'custom', 'off']);

        resumePromptDropdown!.props.onSelect('off');

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

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const resumePromptDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.usageLimitRecovery.resumePromptTitle');
        expect(resumePromptDropdown).toBeTruthy();

        resumePromptDropdown!.props.onSelect('custom');

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
        const input = (inputRow as any)?.props?.subtitle;
        expect(input?.props?.placeholder).toBe('settingsSession.usageLimitRecovery.customResumePromptPlaceholder');
        expect(input?.props?.maxLength).toBe(2000);

        input.props.onChangeText('  Resume exactly where you stopped.  ');
        // The draft is local state; commit happens on blur/submit. Re-grab the row after re-render.
        const updatedInput = (screen.findRowByTitle('settingsSession.usageLimitRecovery.customResumePromptTitle') as any)?.props?.subtitle;
        updatedInput.props.onBlur();

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
