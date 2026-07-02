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

sessionSettingsEntryState.settingsState = {
    agentInputEnterToSend: true,
    agentInputEnterToSendNative: false,
    sessionMessageSendMode: 'server_pending',
    sessionBusySteerSendPolicy: 'steer_immediately',
    sessionPendingQueueDrainMode: 'one_at_a_time',
    alwaysShowContextSize: true,
};

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session composer settings pending queue drain mode', () => {
    it('renders one-at-a-time and drain-all choices when Pending can be used', async () => {
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        expect(screen.findGroup('settingsSession.messageSending.pendingDrainModeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDrainMode.oneAtATimeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDrainMode.drainAllTitle')).toBeTruthy();
    });
});
