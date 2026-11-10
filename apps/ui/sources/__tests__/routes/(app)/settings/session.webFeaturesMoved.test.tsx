import * as React from 'react';
import { Platform } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({ width: 1280, height: 800 }));

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => viewport,
            });
        },
    });
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
const initialStorage = storage.getState();

afterEach(() => {
    viewport.width = 1280;
    viewport.height = 800;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(Platform, 'isPad', { configurable: true, value: false });
    standardCleanup();
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
});

describe('Session composer settings (web features moved)', () => {
    it.each([
        { platform: 'ios', isPad: false, visible: false },
        { platform: 'ios', isPad: true, visible: true },
        { platform: 'web', isPad: false, visible: true },
    ])('offers the right-pane preference only where panels apply ($platform, tablet=$isPad)', async ({ platform, isPad, visible }) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        Object.defineProperty(Platform, 'isPad', { configurable: true, value: isPad });
        viewport.width = platform === 'ios' && !isPad ? 390 : 1280;
        storage.setState({ settings: settingsParse(sessionSettingsEntryState.settingsState) });
        const { default: SessionSettingsScreen } = await import('@/app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const rows = screen.findAllByType(Item).filter((item) => item.props.title === 'settingsAppearance.sessionsRightPaneDefaultOpen');
        expect(rows).toHaveLength(visible ? 1 : 0);
    });

    it('shows Enter-to-send and Message history inside Session composer settings (web)', async () => {
        storage.setState({ settings: settingsParse(sessionSettingsEntryState.settingsState) });
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        const items = screen.findAllByType(Item);
        const titles = items.map((item) => item.props.title);

        expect(titles).toContain('settingsSessionPages.composer.enterToSendTitle');
        expect(titles).toContain('settingsFeatures.historyScope');

        // Message history is a web-only segmented choice between per-session and global history.
        const historyRow = items.find((item) => item.props.testID === 'settings-composer-history-scope');
        expect(historyRow?.props.title).toBe('settingsFeatures.historyScope');
        const historyIds = (historyRow?.props.rightElement?.props.tabs ?? []).map((tab: { id?: string }) => tab.id);
        expect(historyIds).toEqual(['perSession', 'global']);
    });
});
