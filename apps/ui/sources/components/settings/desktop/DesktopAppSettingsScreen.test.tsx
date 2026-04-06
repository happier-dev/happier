import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const autostartState = vi.hoisted(() => ({
    supported: true,
    enabled: false,
    loading: false,
    error: null as string | null,
}));

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
            useLocalSettings: () => ({} as Record<string, unknown>),
        });
    },
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => autostartState,
}));

vi.mock('./DesktopOverlaySettingsSection', () => ({
    DesktopOverlaySettingsSection: () => React.createElement('DesktopOverlaySettingsSection'),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughComponentMock('ItemList'),
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

describe('DesktopAppSettingsScreen', () => {
    beforeEach(() => {
        autostartState.supported = true;
        autostartState.enabled = false;
        autostartState.loading = false;
        autostartState.error = null;
    });

    it('renders the desktop app settings content with the autostart and overlay surfaces', async () => {
        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        const screen = await renderSettingsView(<DesktopAppSettingsScreen />);

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findByType('DesktopOverlaySettingsSection')).toBeTruthy();
    });

    it('hides the autostart section when it is not supported', async () => {
        autostartState.supported = false;
        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        const screen = await renderSettingsView(<DesktopAppSettingsScreen />);

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
        expect(screen.findByType('DesktopOverlaySettingsSection')).toBeTruthy();
    });
});
