import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const autostartState = vi.hoisted(() => ({
    supported: true,
    enabled: false,
    loading: false,
    error: null as string | null,
}));
const localSettingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));

installSettingsViewCommonModuleMocks({
    icons: async () => ({
        Ionicons: undefined,
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSettings: () => localSettingsState.value,
        });
    },
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
}));

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => autostartState,
}));

describe('DesktopAppSettingsScreen (missing vector icons)', () => {
    beforeEach(() => {
        autostartState.supported = true;
        autostartState.enabled = false;
        autostartState.loading = false;
        autostartState.error = null;
        localSettingsState.value = {
            desktopOverlayEnabled: true,
        };
    });

    it('does not crash when Ionicons is unavailable at runtime', async () => {
        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        const screen = await withPopoverWebGlobals(async () => renderSettingsView(<DesktopAppSettingsScreen />));

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-visibility-mode')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-presentation-mode')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-compact-style')).toBeNull();
    });
});
