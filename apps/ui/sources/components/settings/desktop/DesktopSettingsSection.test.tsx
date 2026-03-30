import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const setEnabledMock = vi.fn(async () => {});
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
});

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => desktopAutostartState,
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
        desktopAutostartState.supported = true;
        desktopAutostartState.enabled = false;
        desktopAutostartState.loading = false;
        desktopAutostartState.error = null;
        setEnabledMock.mockReset();
    });

    it('renders nothing when desktop autostart is unsupported', async () => {
        desktopAutostartState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.title')).toBeNull();
    });

    it('renders a launch-at-login switch row and toggles it through the hook', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-autostart-enabled');

        expect(row?.props.rightElement).toBeTruthy();

        row?.props.rightElement.props.onValueChange(true);

        expect(setEnabledMock).toHaveBeenCalledWith(true);
    });
});
