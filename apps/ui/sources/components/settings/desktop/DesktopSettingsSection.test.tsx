import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const setEnabledMock = vi.fn(async () => {});
const applyLocalSettingsMock = vi.fn();
const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const desktopAutostartState = {
    supported: true,
    enabled: false,
    loading: false,
    error: null as string | null,
    setEnabled: setEnabledMock,
};

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSettings: () => ({
                ...localSettingsDefaults,
                desktopOverlayEnabled: true,
            }),
        });
    },
});

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => desktopAutostartState,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassthroughComponentMock('Switch'),
}));

describe('DesktopSettingsSection', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
        desktopAutostartState.supported = true;
        desktopAutostartState.enabled = false;
        desktopAutostartState.loading = false;
        desktopAutostartState.error = null;
        setEnabledMock.mockReset();
        applyLocalSettingsMock.mockReset();
    });

    it('renders the overlay settings section even when desktop autostart is unsupported', async () => {
        desktopAutostartState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeTruthy();
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
    });

    it('renders a launch-at-login switch row and toggles it through the hook', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-autostart-enabled');

        expect(row?.props.rightElement).toBeTruthy();

        row?.props.rightElement.props.onValueChange(true);

        expect(setEnabledMock).toHaveBeenCalledWith(true);
    });

    it('includes the overlay controls host group on supported desktop builds', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeTruthy();
    });

    it('does not render desktop overlay controls on non-Tauri builds', async () => {
        tauriDesktopState.value = false;
        desktopAutostartState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeNull();
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
    });
});
