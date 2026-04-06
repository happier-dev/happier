import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const applyLocalSettingsMock = vi.fn();
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const localSettingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));

installSettingsViewCommonModuleMocks({
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

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: () => resetDesktopActivityOverlayPositionMock(),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

describe('DesktopOverlaySettingsSection', () => {
    beforeEach(() => {
        applyLocalSettingsMock.mockReset();
        resetDesktopActivityOverlayPositionMock.mockReset();
        localSettingsState.value = {
            ...localSettingsDefaults,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
            desktopOverlayShowWhenRunning: true,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: true,
            desktopOverlayAlwaysOnTop: true,
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 6_000,
            desktopOverlayExpandedBehavior: 'click',
            desktopOverlayInteractiveCollapsed: true,
            desktopOverlayEnableDragReposition: false,
            desktopOverlayLockPosition: true,
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
            desktopOverlayClickAction: 'expand_overlay',
            desktopOverlayDensity: 'compact',
            desktopOverlayShowSessionCount: true,
            desktopOverlayShowPreviewText: false,
            desktopOverlayCompactStyle: 'pill',
        };
    });

    it('renders the desktop overlay settings group', async () => {
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(8);
    });

    it('writes overlay visibility and placement changes through the dropdown menu controls', async () => {
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        const dropdownMenus = screen.findAllByType('DropdownMenu' as any);

        const visibilityMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.visibilityModeTitle');
        expect(visibilityMenu).toBeTruthy();
        visibilityMenu?.props.onSelect?.('always_when_enabled');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayVisibilityMode: 'always_when_enabled',
        });

        const autoHideMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.autoHideDelayTitle');
        expect(autoHideMenu).toBeTruthy();
        autoHideMenu?.props.onSelect?.('10000');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayAutoHideDelayMs: 10_000,
        });

        const anchorMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.anchorPresetTitle');
        expect(anchorMenu).toBeTruthy();
        anchorMenu?.props.onSelect?.('bottom_right');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayAnchor: 'bottom_right',
        });

        const densityMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.densityTitle');
        expect(densityMenu).toBeTruthy();
        densityMenu?.props.onSelect?.('comfortable');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayDensity: 'comfortable',
        });

        const compactStyleMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.compactStyleTitle');
        expect(compactStyleMenu).toBeTruthy();
        compactStyleMenu?.props.onSelect?.('panel');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayCompactStyle: 'panel',
        });
    });

    it('writes overlay toggles through the local settings writer', async () => {
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        const readyRow = screen.findRowByTitle('settingsDesktop.overlay.showWhenReadyTitle');
        expect(readyRow).toBeTruthy();
        readyRow?.props.rightElement.props.onValueChange(false);

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayShowWhenReady: false,
        });
    });

    it('hides auto-hide delay choices when auto-hide is disabled', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayAutoHideEnabled: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.autoHideDelayTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.autoHideDelay10sTitle')).toBeNull();
    });

    it('hides placement-dependent rows when the desktop overlay is turned off', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(0);
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenRunningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenAttentionRequiredTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenReadyTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.alwaysOnTopTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.autoHideEnabledTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.interactiveCollapsedTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.allowRepositioningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.lockPositionTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeNull();
    });

    it('hides collapsed action rows when collapsed interactivity is disabled', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayInteractiveCollapsed: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.interactiveCollapsedTitle')).toBeTruthy();
        expect(screen.findAllByType('DropdownMenu' as any).some((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.collapsedClickActionTitle')).toBe(false);
        expect(screen.findAllByType('DropdownMenu' as any).some((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.expandedBehaviorTitle')).toBe(false);
    });

    it('hides expanded behavior rows when collapsed clicks do not expand the overlay', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayClickAction: 'open_sessions',
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findAllByType('DropdownMenu' as any).some((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.collapsedClickActionTitle')).toBeTruthy();
        expect(screen.findAllByType('DropdownMenu' as any).some((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.expandedBehaviorTitle')).toBe(false);
    });

    it('resets custom placement back to anchored defaults', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        screen.pressRowByTitle('settingsDesktop.overlay.resetPositionTitle');

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
        });
        expect(resetDesktopActivityOverlayPositionMock).toHaveBeenCalledTimes(1);
    });
});
