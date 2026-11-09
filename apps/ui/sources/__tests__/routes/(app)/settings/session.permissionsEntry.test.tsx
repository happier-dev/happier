import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks();
});
vi.doUnmock('@/sync/domains/state/storage');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
await Promise.all([
    import('@/app/(app)/settings/session'),
    import('@/app/(app)/settings/session/provider-limits'),
]);
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let foldersEnabled = false;

async function renderSettingsView(element: React.ReactElement) {
    const features = createRootLayoutFeaturesResponse();
    for (const [id, enabled] of [['sessions', true], ['sessions.folders', foldersEnabled]] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, id, enabled)) throw new Error(`Missing fixture feature ${id}`);
    }
    account = await createSecretSettingsTestHarness({ features, settings: settingsParse({ ...sessionSettingsEntryState.settingsState,
        experiments: true, featureToggles: { 'sessions.folders': foldersEnabled },
    }), sharedEnabled: false });
    storage.setState({ localSettings: localSettingsParse(sessionSettingsEntryState.settingsState) });
    return renderBaseSettingsView(element);
}

async function expectPersistedSettings(delta: Record<string, unknown>) {
    await vi.waitFor(() => expect(storage.getState().settings).toMatchObject(delta));
    await vi.waitFor(() => expect(account?.persistedSettings).toMatchObject(delta));
}

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    foldersEnabled = false;
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

        await vi.waitFor(() => {
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/composer');
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/provider-limits');
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/resume');
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session/runtime');
        });
    });

    it('ends with the links to the detailed session pages, after the settings on this page', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType(ItemGroup).map((group) => group.props.title);

        expect(groupTitles[groupTitles.length - 1]).toBe('settingsSession.detailedBehavior.title');
    });

    it('regroups root settings by user intent instead of one large session list section', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType(ItemGroup).map((group) => group.props.title);

        expect(groupTitles).toEqual([
            'settingsSession.rootGroups.listOrganization.title',
            'settingsSession.rootGroups.rowDetails.title',
            'sessionsList.spacesTitle',
            'settingsSession.rootGroups.launchDefaults.title',
            'settingsSession.rootGroups.activitySignals.title',
            'settingsSession.rootGroups.mobileLayout.title',
            'workspaceTabs.sectionTitle',
            'settingsSession.rootGroups.agentPersonalization.title',
            'settingsSession.detailedBehavior.title',
        ]);
        expect(groupTitles).not.toContain('settingsSession.sessionCreation.title');
        expect(groupTitles).not.toContain('settingsSession.sessionList.title');
    });

    it('places session list controls into focused root groups', async () => {
        foldersEnabled = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitleForRow = (title: string) => {
            const row = screen.findRowByTitle(title);
            const groups = screen.findAllByType(ItemGroup);
            let current = row?.parent;
            while (current) {
                if (groups.includes(current)) return current.props?.title;
                current = current.parent;
            }
            return null;
        };

        const expectedPlacements = new Map<string, string>([
            ['settingsSession.sessionCreation.startWithTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsSession.sessionCreation.rememberLastProjectSelectionsTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsSession.sessionCreation.rememberLastEngineSelectionsTitle', 'settingsSession.rootGroups.launchDefaults.title'],
            ['settingsAppearance.sessionListDensity.title', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsSession.sessionList.layoutTitle', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsFeatures.hideInactiveSessions', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsAppearance.sessionsRightPaneDefaultOpen', 'settingsSession.rootGroups.listOrganization.title'],
            ['settingsSession.sessionList.tagsTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.identityDisplayTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.activeColorTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.rowContextTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.workspaceFaviconsTitle', 'settingsSession.rootGroups.rowDetails.title'],
            ['settingsSession.sessionList.attentionPlacementTitle', 'settingsSession.rootGroups.activitySignals.title'],
            ['settingsSession.mobileWorkspaceExperience.title', 'settingsSession.rootGroups.mobileLayout.title'],
            ['settingsSession.promptPersonalization.askAgentToRenameSessionsTitle', 'settingsSession.rootGroups.agentPersonalization.title'],
            ['settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle', 'settingsSession.rootGroups.agentPersonalization.title'],
        ]);

        for (const [rowTitle, expectedGroupTitle] of expectedPlacements) {
            expect(groupTitleForRow(rowTitle)).toBe(expectedGroupTitle);
        }
    });

    it('does not render detailed composer, provider-limit, resume, or runtime controls on the root session settings screen', async () => {
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

        const titles = screen.findAllByType(Item).map((item) => item.props.title);

        expect(titles).not.toContain('settings.permissions');
        expect(titles).not.toContain('settingsSession.defaultPermissions.applyPermissionChangesTitle');
    });

    it('offers how new sessions start as a visible composer-or-wizard choice', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findAllByType(DropdownMenu).some((dropdown) =>
            dropdown.props.itemTrigger?.title === 'settingsSession.sessionCreation.modalModeTitle'
        )).toBe(false);
        const startWith = screen.findByProps({ testIDPrefix: 'settings-session-startWith' });
        // Search opens this row by its declared anchor.
        expect(screen.root.findAll((node: any) => node.props?.setting?.anchor === 'session.startWith').length).toBeGreaterThan(0);
        expect(startWith.props.value).toBe('composer');
        expect(startWith.props.options.map((option: { id: string }) => option.id)).toEqual(['composer', 'wizard']);
        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle')).toBeNull();

        await act(async () => {
            startWith.props.onChange('wizard');
        });
        await expectPersistedSettings({ useEnhancedSessionWizard: true });
    });

    it('shows the wizard disposition link only when wizard modal mode is selected', async () => {
        sessionSettingsEntryState.settingsState.useEnhancedSessionWizard = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle')).toBeTruthy();
        screen.pressRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle');
        await vi.waitFor(() => expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/new-session-wizard'));
    });

    it('renders remembered project session selections in the new-session modal group', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(row).toBeTruthy();

        let current = row?.parent;
        let groupTitle: unknown;
        const groups = screen.findAllByType(ItemGroup);
        while (current) {
            if (groups.includes(current)) {
                groupTitle = current.props?.title;
                break;
            }
            current = current.parent;
        }

        expect(groupTitle).toBe('settingsSession.rootGroups.launchDefaults.title');

        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        await expectPersistedSettings({ rememberLastProjectSessionSelections: false });
    });

    it('renders remembered engine selections in the new-session modal group', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.rememberLastEngineSelectionsTitle');
        expect(row).toBeTruthy();

        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastEngineSelectionsTitle');
        await expectPersistedSettings({ rememberLastEngineSelectionsV1: false });
    });

    it('renders provider usage gauge settings and updates gauge visibility and preferred window on the provider limits page', async () => {
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeMode = 'auto';
        sessionSettingsEntryState.settingsState.sessionProviderUsageGaugeWindowMode = 'most_constrained';
        const mod = await import('@/app/(app)/settings/session/provider-limits');
        const ProviderLimitsSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(ProviderLimitsSettingsScreen));

        const field = screen.findAll(node => node.props.testID === 'settings-session-providerUsageGauge-window-trigger'
            && typeof node.props.onCommit === 'function')[0];

        expect(screen.findRowByTitle('settingsSession.providerUsageGauge.visibilityTitle')).toBeTruthy();
        expect(field).toBeTruthy();
        expect(field?.props.selectedIds).toEqual(['most_constrained']);
        expect(field?.props.candidates?.map((item: { id: string }) => item.id)).toEqual([
            'most_constrained',
            'daily',
            'weekly',
            'session',
            'primary',
            'secondary',
        ]);

        await act(async () => { field!.props.onCommit(['weekly']); });
        await expectPersistedSettings({ sessionProviderUsageGaugeWindowModes: ['weekly'] });
        screen.pressRowByTitle('settingsSession.providerUsageGauge.visibilityTitle');

        await expectPersistedSettings({ sessionProviderUsageGaugeMode: 'hidden', sessionProviderUsageGaugeWindowModes: ['weekly'] });
    });

});
