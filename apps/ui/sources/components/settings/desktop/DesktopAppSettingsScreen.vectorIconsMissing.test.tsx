/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { storage } from '@/sync/domains/state/storage';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    icons: async () => ({
        Ionicons: undefined,
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: 'real',
});

const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');

describe('DesktopAppSettingsScreen (missing vector icons)', () => {
    afterEach(async () => {
        await standardCleanup();
        vi.unstubAllGlobals();
    });

    it('does not crash when Ionicons is unavailable at runtime', async () => {
        const secureStorage = createDesktopSecureStorageBoundary();
        let callbackId = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_host_get_availability') return Promise.resolve({
                activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
            });
            if (command === 'plugin:event|listen') return Promise.resolve(++callbackId);
            return secureStorage.invoke(command, args);
        }, transformCallback: () => ++callbackId });
        vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
        const originalSettings = storage.getState().localSettings;
        storage.setState({ localSettings: { ...originalSettings, desktopOverlayEnabled: true } });
        try {
            const screen = await renderSettingsView(<DesktopAppSettingsScreen />);
            expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
            await vi.waitFor(() => expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy());
            expect(screen.findRow('settings-desktop-overlay-visibility-mode')).toBeTruthy();
            expect(screen.findRow('settings-desktop-notch-conversation-presentation')).toBeTruthy();
            expect(screen.findRow('settings-desktop-overlay-compact-style')).toBeNull();
        } finally {
            storage.setState({ localSettings: originalSettings });
        }
    });
});
