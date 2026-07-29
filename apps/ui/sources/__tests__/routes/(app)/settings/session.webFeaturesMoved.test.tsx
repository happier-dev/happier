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
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1280, height: 800 }),
        });
    },
});

sessionSettingsEntryState.settingsState = {
    agentInputEnterToSend: false,
    agentInputHistoryScope: 'perSession',
    sessionMessageSendMode: 'agent_queue',
    sessionBusySteerSendPolicy: 'steer_immediately',
    terminalConnectLegacySecretExportEnabled: false,
    sessionReplayEnabled: false,
    sessionReplayStrategy: 'recent_messages',
    sessionReplayRecentMessagesCount: 100,
    sessionUseTmux: false,
    sessionTmuxSessionName: null,
    sessionTmuxIsolated: false,
    sessionTmuxTmpDir: null,
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: true,
};

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session composer settings (web features moved)', () => {
    it('shows Enter-to-send and Message history inside Session composer settings (web)', async () => {
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const dropdownTriggerTitles = dropdowns
            .map((dropdown) => dropdown.props?.itemTrigger?.title)
            .filter((title): title is string => typeof title === 'string');

        expect(titles).toContain('settingsFeatures.enterToSend');
        expect([...titles, ...dropdownTriggerTitles]).toContain('settingsFeatures.historyScope');

        const historyDropdown = dropdowns.find((dropdown) => {
            const ids = (dropdown.props.items ?? []).map((item: { id?: string }) => item.id);
            return ids.includes('global') && ids.includes('perSession');
        });

        expect(historyDropdown).toBeTruthy();
    });
});
