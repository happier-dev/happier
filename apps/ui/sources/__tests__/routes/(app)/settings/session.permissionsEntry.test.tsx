import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks();

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session settings (Permissions entry)', () => {
    it('renders explicit hub entries for detailed session behavior areas', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.composer.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.providerLimits.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.resume.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.runtime.title')).toBeTruthy();

        screen.pressRowByTitle('settingsSession.composer.title');
        screen.pressRowByTitle('settingsSession.providerLimits.title');
        screen.pressRowByTitle('settingsSession.resume.title');
        screen.pressRowByTitle('settingsSession.runtime.title');

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/composer');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/provider-limits');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/resume');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/runtime');
    });

    it('shows the detailed behavior hub before legacy session controls', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType('ItemGroup' as any).map((group) => group.props.title);

        expect(groupTitles.indexOf('settingsSession.detailedBehavior.title')).toBeLessThan(
            groupTitles.indexOf('settingsSession.rootGroups.launchDefaults.title'),
        );
        expect(groupTitles.indexOf('settingsSession.detailedBehavior.title')).toBeLessThan(
            groupTitles.indexOf('settingsSession.rootGroups.listOrganization.title'),
        );
    });

    it('regroups root settings by user intent instead of one large session list section', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType('ItemGroup' as any).map((group) => group.props.title);

        expect(groupTitles).toEqual([
            'settingsSession.detailedBehavior.title',
            'settingsSession.rootGroups.launchDefaults.title',
            'settingsSession.rootGroups.listOrganization.title',
            'settingsSession.rootGroups.rowDetails.title',
            'settingsSession.rootGroups.activitySignals.title',
            'settingsSession.rootGroups.mobileLayout.title',
            'settingsSession.rootGroups.agentPersonalization.title',
        ]);
        expect(groupTitles).not.toContain('settingsSession.sessionCreation.title');
        expect(groupTitles).not.toContain('settingsSession.sessionList.title');
    });

    it('places session list controls into focused root groups', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitleForRow = (title: string) => {
            const row = screen.findRowByTitle(title);
            let current = row?.parent;
            while (current) {
                if ((current.type as unknown) === 'ItemGroup') return current.props?.title;
                current = current.parent;
            }
            return null;
        };

        const expectedPlacements = new Map<string, string>([
            ['settingsSession.sessionCreation.wizardModeTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsSession.sessionCreation.rememberLastProjectSelectionsTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsSession.sessionCreation.rememberLastEngineSelectionsTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsAppearance.sessionListDensity.title', 'settingsSession.rootGroups.listOrganization.title'],
            ['sessionsList.orderingMode.title', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsSession.sessionList.folderSortModeTitle', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsSession.sessionList.sectionModeTitle', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsFeatures.sessionListActiveGrouping', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsFeatures.sessionListInactiveGrouping', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsFeatures.hideInactiveSessions', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsAppearance.sessionsRightPaneDefaultOpen', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsSession.sessionList.tagsTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.identityDisplayTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.activeColorTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.workspacePathDisplayTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.workspaceFaviconsTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.workspaceMachineSubtitlesTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.workingStatusAnimatedTextTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.sessionList.attentionPromotionModeTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.sessionList.attentionStandingDefaultTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.sessionList.workingPlacementModeTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.sessionList.workingIndicatorTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.mobileWorkspaceExperience.title', 'settingsSession.rootGroups.mobileLayout.title'],
            ['settingsSession.promptPersonalization.askAgentToRenameSessionsTitle', 'settingsSession.rootGroups.agentPersonalization.title'],
            ['settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle', 'settingsSession.rootGroups.agentPersonalization.title'],
        ]);

        for (const [rowTitle, expectedGroupTitle] of expectedPlacements) {
            expect(groupTitleForRow(rowTitle)).toBe(expectedGroupTitle);
        }
    });

    it('does not render detailed composer, provider-limit, resume, or runtime controls on the root session settings screen', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery' || featureId === 'connectedServices.quotas';
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsFeatures.enterToSend')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.messageSending.queueInAgentTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.usageLimitRecovery.modeTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.providerUsageGauge.visibilityTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.replayResume.enabledTitle')).toBeNull();
        expect(screen.findRowByTitle('profiles.tmux.spawnSessionsTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.terminalConnect.legacySecretExportTitle')).toBeNull();
    });

    it('does not render a permissions entry or inline permission controls on the root session settings screen', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);

        expect(titles).not.toContain('settings.permissions');
        expect(titles).not.toContain('settingsSession.defaultPermissions.applyPermissionChangesTitle');
    });

    it('renders wizard mode as a toggle in the new-session modal group', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findAllByType('DropdownMenu' as any).some((dropdown) =>
            dropdown.props.itemTrigger?.title === 'settingsSession.sessionCreation.modalModeTitle'
        )).toBe(false);
        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardModeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle')).toBeNull();

        screen.pressRowByTitle('settingsSession.sessionCreation.wizardModeTitle');
        expect(sessionSettingsEntryState.settingsState.useEnhancedSessionWizard).toBe(true);
    });

    it('shows the wizard disposition link only when wizard modal mode is selected', async () => {
        sessionSettingsEntryState.settingsState.useEnhancedSessionWizard = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle')).toBeTruthy();
        screen.pressRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/new-session-wizard');
    });

    it('renders remembered project session selections in the new-session modal group', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(row).toBeTruthy();

        let current = row?.parent;
        let groupTitle: unknown;
        while (current) {
            if ((current.type as unknown) === 'ItemGroup') {
                groupTitle = current.props?.title;
                break;
            }
            current = current.parent;
        }

        expect(groupTitle).toBe('settingsSession.rootGroups.launchDefaults.title');

        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(sessionSettingsEntryState.settingsState.rememberLastProjectSessionSelections).toBe(false);
    });

    it('renders remembered engine selections in the new-session modal group', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.rememberLastEngineSelectionsTitle');
        expect(row).toBeTruthy();

        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastEngineSelectionsTitle');
        expect(sessionSettingsEntryState.settingsState.rememberLastEngineSelectionsV1).toBe(false);
    });

    it('renders one global usage-limit recovery setting with no provider overrides on the provider limits page', async () => {
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
        sessionSettingsEntryState.options.featureEnabled = (featureId) => featureId === 'sessions.usageLimitRecovery';
        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        type DropdownItem = { id: string };
        const dropdown = dropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-usageLimitRecovery-trigger'
        );

        expect(dropdown).toBeTruthy();
        expect(dropdown?.props.selectedId).toBe('ask');
        expect(dropdown?.props.items?.map((item: DropdownItem) => item.id)).toEqual(['ask', 'auto_wait']);

        dropdown?.props.onSelect('auto_wait');

        expect(sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'standard',
        });
        const resumePromptDropdown = dropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-usageLimitRecovery-resumePrompt-trigger'
        );
        expect(resumePromptDropdown).toBeTruthy();
        expect(resumePromptDropdown?.props.selectedId).toBe('standard');
        expect(resumePromptDropdown?.props.items?.map((item: DropdownItem) => item.id)).toEqual(['standard', 'custom', 'off']);

        resumePromptDropdown?.props.onSelect('off');

        expect(sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1).toEqual({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'off',
        });
        expect(screen.findRowByTitle('settingsSession.usageLimitRecovery.providerOverridesTitle')).toBeNull();
    });

    it('hides usage-limit recovery settings when the server feature is disabled on the provider limits page', async () => {
        sessionSettingsEntryState.settingsState.usageLimitRecoverySettingsV1 = { v: 1, mode: 'ask' };
        sessionSettingsEntryState.options.featureEnabled = (featureId) => featureId !== 'sessions.usageLimitRecovery';
        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        expect(dropdowns.some((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-usageLimitRecovery-trigger',
        )).toBe(false);
    });

    it('renders provider usage gauge settings and updates gauge visibility and preferred window on the provider limits page', async () => {
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeMode = 'auto';
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeWindowMode = 'most_constrained';
        sessionSettingsEntryState.options.featureEnabled = (featureId) => featureId === 'connectedServices.quotas';
        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const toggleRow = screen.findRowByTitle('settingsSession.providerUsageGauge.visibilityTitle');
        const dropdown = screen.findAllByType('DropdownMenu' as any).find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-providerUsageGauge-window-trigger'
        );

        expect(toggleRow).toBeTruthy();
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props.selectedId).toBe('most_constrained');
        expect(dropdown?.props.items?.map((item: any) => item.id)).toEqual([
            'most_constrained',
            'daily',
            'weekly',
            'session',
            'primary',
            'secondary',
        ]);

        screen.pressRowByTitle('settingsSession.providerUsageGauge.visibilityTitle');
        dropdown?.props.onSelect('weekly');

        expect(sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeMode).toBe('hidden');
        expect(sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeWindowMode).toBe('weekly');
    });

    it('renders animated working status text as a session list setting', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionList.workingStatusAnimatedTextTitle');
        expect(row).toBeTruthy();

        let current = row?.parent;
        let groupTitle: unknown;
        while (current) {
            if ((current.type as unknown) === 'ItemGroup') {
                groupTitle = current.props?.title;
                break;
            }
            current = current.parent;
        }

        expect(groupTitle).toBe('settingsSession.rootGroups.activitySignals.title');

        screen.pressRowByTitle('settingsSession.sessionList.workingStatusAnimatedTextTitle');
        expect(sessionSettingsEntryState.settingsState.sessionListWorkingStatusAnimatedTextEnabled).toBe(false);
    });

    it('renders working indicator style as a session list setting', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const dropdown = screen.findAllByType('DropdownMenu' as any).find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-workingIndicator-trigger'
        );
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props.selectedId).toBe('spinner');

        dropdown?.props.onSelect('pulse');

        expect(sessionSettingsEntryState.settingsState.sessionListNarrowWorkingIndicatorStyle).toBe('pulse');
    });
});
