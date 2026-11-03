import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installSessionSettingsEntryModuleMocks();
installDisconnectedServerSocketBoundary();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderSettingsView(element: React.ReactElement) {
    const features = createRootLayoutFeaturesResponse({ features: {
        sessions: { enabled: true, usageLimitRecovery: { enabled: true } },
    } });
    account = await createSecretSettingsTestHarness({
        settings: settingsParse(sessionSettingsEntryState.settingsState), features, sharedEnabled: false,
    });
    return renderBaseSettingsView(element);
}

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    resetSessionSettingsEntryState();
});

type SettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

/** The real resume-prompt row exposes its segmented control as the right element. */
function resumePromptChoice(screen: SettingsScreen) {
    const row = screen.findAllByType(Item).find(node => node.props?.testID === 'settings-session-usage-limit-recovery-resume-prompt');
    if (!row) throw new Error('Missing the resume prompt choice');
    return row;
}

describe('Session settings (prompt personalization)', () => {
    it('round-trips the Account compaction switch while preserving title and response preferences', async () => {
        sessionSettingsEntryState.settingsState.codingPromptBehaviorV1 = {
            v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'disabled',
        };
        const { default: SessionSettingsScreen } = await import('@/app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const compaction = () => screen.findAllByType(Item).find(node => node.props.testID === 'settings-session-compaction-nudge');
        expect(compaction()).toBeTruthy();
        expect(compaction()!.props.rightElement.props.value).toBe(false);
        await act(async () => {
            compaction()!.props.rightElement.props.onValueChange(true);
            await vi.waitFor(() => expect(storage.getState().settings.codingPromptBehaviorV1).toEqual({
                v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'disabled', sessionCompactionNudge: true,
            }));
        });
        const title = screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.testID === 'settings-session-title-updates-mode-trigger'
            || node.props.itemTrigger?.itemProps?.testID === 'settings-session-title-updates-mode-trigger');
        await act(async () => { await title!.props.onSelect('initial'); });
        await vi.waitFor(() => expect(storage.getState().settings.codingPromptBehaviorV1).toMatchObject({
            sessionTitleUpdates: 'initial', responseOptions: 'disabled', sessionCompactionNudge: true,
        }));
        await act(async () => {
            compaction()!.props.onPress();
            await vi.waitFor(() => expect(storage.getState().settings.codingPromptBehaviorV1).toMatchObject({
                sessionTitleUpdates: 'initial', responseOptions: 'disabled', sessionCompactionNudge: false,
            }));
        });
    });

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

        const groupTitles = screen.findAllByType(ItemGroup).map((group) => group.props.title);
        expect(groupTitles).toContain('settingsSession.rootGroups.agentPersonalization.title');
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')).toBeTruthy();

        const dropdowns = screen.findAllByType(DropdownMenu);
        const titleDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle');
        expect(titleDropdown).toBeTruthy();
        expect(titleDropdown?.props?.selectedId).toBe('ongoing');
        expect(titleDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['disabled', 'initial', 'ongoing']);

        await act(async () => { await titleDropdown!.props.onSelect('initial'); });
        await vi.waitFor(() => expect(storage.getState().settings.codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'initial',
            sessionCompactionNudge: false,
            responseOptions: 'agent',
        }));
    });

    it('selects the custom resume prompt mode while preserving the saved custom text', async () => {
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

        const resumePrompt = resumePromptChoice(screen);
        expect(resumePrompt.props.title).toBe('settingsSession.usageLimitRecovery.resumePromptTitle');
        expect(resumePrompt.props.rightElement.props.activeTabId).toBe('standard');
        expect(resumePrompt.props.rightElement.props.tabs.map((tab: any) => tab.id)).toEqual(['standard', 'custom', 'off']);

        await act(async () => {
            resumePrompt.props.rightElement.props.onSelectTab('custom');
        });

        await vi.waitFor(() => expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Pick the task back up.',
        }));
    });

    it('shows the inline custom prompt input when custom mode is selected and commits trimmed text', async () => {
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
        // The inline field belongs to the real row's right element.
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

        await vi.waitFor(() => expect(storage.getState().settings.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: 'Resume exactly where you stopped.',
        }));
    });

    it('hides the inline custom prompt input when custom mode is not selected', async () => {
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
