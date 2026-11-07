import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

installSessionSettingsEntryModuleMocks();

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session settings worktree grouping', () => {
    it('lets users keep separate directory groups for Git worktrees', async () => {
        sessionSettingsEntryState.settingsState.sessionListGroupGitWorktreesV1 = true;
        const { default: SessionSettingsScreen } = await import('../../../../app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const item = screen.findRowByTitle('settingsFeatures.sessionListGroupGitWorktrees');
        expect(item).toBeTruthy();
        const toggle = item!.props.rightElement;
        expect(toggle.props.value).toBe(true);
        await act(async () => { toggle.props.onValueChange(false); });
        expect(sessionSettingsEntryState.settingsState.sessionListGroupGitWorktreesV1).toBe(false);
    });
});
