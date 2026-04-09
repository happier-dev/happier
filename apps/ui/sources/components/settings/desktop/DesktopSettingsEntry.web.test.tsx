import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const tauriDesktopState = vi.hoisted(() => ({ value: false }));
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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

describe('DesktopSettingsEntry web variant', () => {
    beforeEach(() => {
        tauriDesktopState.value = false;
        routerPushMock.mockReset();
    });

    it('renders nothing on non-Tauri web runtimes', async () => {
        const { DesktopSettingsEntry } = await import('./DesktopSettingsEntry.web');
        const screen = await renderSettingsView(React.createElement(DesktopSettingsEntry));

        expect(screen.tree.toJSON()).toBeNull();
    });

    it('renders the desktop settings entry inside the Tauri webview runtime', async () => {
        tauriDesktopState.value = true;

        const { DesktopSettingsEntry } = await import('./DesktopSettingsEntry.web');
        const screen = await renderSettingsView(React.createElement(DesktopSettingsEntry));

        const row = screen.findRow('settings-desktop-entry');
        expect(row).toBeTruthy();
        expect(row?.props.title).toBe('settingsDesktop.title');

        row?.props.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/desktop');
    });
});
