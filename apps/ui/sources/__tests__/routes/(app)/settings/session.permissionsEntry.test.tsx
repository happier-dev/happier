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

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/composer');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/provider-limits');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/resume');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/runtime');
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

        expect(groupTitleForRow('settingsSession.sessionCreation.wizardModeTitle')).toBe('settingsSession.rootGroups.launchDefaults.title');
        expect(groupTitleForRow('settingsAppearance.sessionListDensity.title')).toBe('settingsSession.rootGroups.listOrganization.title');
        expect(groupTitleForRow('settingsSession.sessionList.identityDisplayTitle')).toBe('settingsSession.rootGroups.rowDetails.title');
        expect(groupTitleForRow('settingsSession.sessionList.workingIndicatorTitle')).toBe('settingsSession.rootGroups.activitySignals.title');
        expect(groupTitleForRow('settingsSession.mobileWorkspaceExperience.title')).toBe('settingsSession.rootGroups.mobileLayout.title');
        expect(groupTitleForRow('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBe('settingsSession.rootGroups.agentPersonalization.title');
    });

    it('does not render detailed composer, provider-limit, resume, or runtime controls on the root session settings screen', async () => {
        sessionSettingsEntryState.options.featureEnabled = (featureId) =>
            featureId === 'sessions.usageLimitRecovery' || featureId === 'connectedServices.quotas';
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsFeatures.enterToSend')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.messageSending.queueInAgentTitle')).toBeNull();
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

    it('renders provider usage gauge settings and updates gauge visibility and preferred window on the provider limits page', async () => {
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeMode = 'auto';
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeWindowMode = 'most_constrained';
        sessionSettingsEntryState.options.featureEnabled = (featureId) => featureId === 'connectedServices.quotas';
        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const dropdown = screen.findAllByType('DropdownMenu' as any).find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-providerUsageGauge-window-trigger'
        );

        expect(screen.findRowByTitle('settingsSession.providerUsageGauge.visibilityTitle')).toBeTruthy();
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

    it('renders the animated working-status toggle row in session list activity settings', async () => {
        sessionSettingsEntryState.settingsState.sessionListWorkingStatusAnimatedTextEnabled = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionList.workingStatusAnimatedTextTitle');
        expect(row).toBeTruthy();
        expect(row?.props.testID).toBe('settings-session-workingStatusAnimatedText-item');

        expect(row?.props.rightElement?.props.testID).toBe('settings-session-workingStatusAnimatedText-toggle');
        expect(row?.props.rightElement?.props.value).toBe(true);

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
