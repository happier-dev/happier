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
    it('does not render a permissions entry or inline permission controls on the root session settings screen', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);

        expect(titles).not.toContain('settings.permissions');
        expect(titles).not.toContain('settingsSession.defaultPermissions.applyPermissionChangesTitle');
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

        expect(groupTitle).toBe('settingsSession.sessionCreation.title');

        screen.pressRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle');
        expect(sessionSettingsEntryState.settingsState.rememberLastProjectSessionSelections).toBe(false);
    });

    it('renders wizard mode as a toggle in the new-session modal group', async () => {
        sessionSettingsEntryState.settingsState.useEnhancedSessionWizard = false;

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findAllByType('DropdownMenu' as any).some((dropdown: any) =>
            dropdown.props.itemTrigger?.title === 'settingsSession.sessionCreation.modalModeTitle'
        )).toBe(false);
        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardModeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle')).toBeNull();

        screen.pressRowByTitle('settingsSession.sessionCreation.wizardModeTitle');
        expect(sessionSettingsEntryState.settingsState.useEnhancedSessionWizard).toBe(true);
    });

    it('shows the wizard disposition link in the new-session modal group when wizard mode is selected', async () => {
        sessionSettingsEntryState.settingsState.useEnhancedSessionWizard = true;

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const row = screen.findRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle');
        expect(row).toBeTruthy();
        expect(row?.props?.subtitle).toBe('settingsSession.sessionCreation.wizardDispositionSubtitle');

        screen.pressRowByTitle('settingsSession.sessionCreation.wizardDispositionTitle');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/new-session-wizard');
    });
});
