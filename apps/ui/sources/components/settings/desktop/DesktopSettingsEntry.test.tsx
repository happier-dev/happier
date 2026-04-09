import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const routerPushMock = vi.fn();

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: routerPushMock,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

describe('DesktopSettingsEntry', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
        routerPushMock.mockReset();
    });

    it('renders a desktop entry that routes to the dedicated desktop app settings page', async () => {
        const { DesktopSettingsEntry } = await import('./DesktopSettingsEntry');
        const screen = await renderSettingsView(<DesktopSettingsEntry />);

        const row = screen.findRow('settings-desktop-entry');
        expect(row).toBeTruthy();
        expect(row?.props.title).toBe('settingsDesktop.title');
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeNull();

        row?.props.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/desktop');
    });

    it('hides the desktop entry on non-Tauri builds', async () => {
        tauriDesktopState.value = false;
        const { DesktopSettingsEntry } = await import('./DesktopSettingsEntry');
        const screen = await renderSettingsView(<DesktopSettingsEntry />);

        expect(screen.findRow('settings-desktop-entry')).toBeNull();
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
    });
});
