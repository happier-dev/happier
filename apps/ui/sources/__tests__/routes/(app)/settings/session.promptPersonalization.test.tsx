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

describe('Session settings (prompt personalization)', () => {
    it('renders prompt personalization controls on the root session settings screen', async () => {
        sessionSettingsEntryState.settingsState.codingPromptBehaviorV1 = {
            v: 1,
            sessionTitleUpdates: 'agent',
            responseOptions: 'agent',
        };

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType('ItemGroup' as any).map((group) => group.props.title);
        expect(groupTitles).toContain('settingsSession.promptPersonalization.title');
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')).toBeTruthy();

        screen.pressRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle');
        expect(sessionSettingsEntryState.settingsState.codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'disabled',
            responseOptions: 'agent',
        });
    });
});
