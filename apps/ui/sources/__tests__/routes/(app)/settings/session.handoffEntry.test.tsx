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
    useDeviceType: 'tablet',
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        });
    },
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session resume settings (Handoff entry)', () => {
    it('includes a handoff entry that routes to /settings/session/handoff', async () => {
        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionResumeSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.handoff.title')).toBeTruthy();

        screen.pressRowByTitle('settingsSession.handoff.title');

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/handoff');
    });
});
