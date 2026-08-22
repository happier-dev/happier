import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { flushHookEffects, renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';

const applyLocalSettingsMock = vi.fn();
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(async () => null),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);
const localSettingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));

function createDesktopOverlayWindowStatePayload(
    hostMode: 'floating' | 'notch_integrated',
): DesktopActivityOverlayWindowStatePayload {
    return {
        visible: true,
        expanded: false,
        model: {
            visible: true,
            isExpanded: false,
            generatedAt: Date.now(),
            collapsed: {
                title: 'Session One',
                statusText: 'Needs attention',
                defaultTarget: 'open-primary-session',
                sessionCount: 1,
            },
            expanded: {
                title: 'Active sessions',
                rows: [],
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
        },
        policy: {
            ...localSettingsDefaults,
            enabled: true,
            visibilityMode: 'attention_only',
            showWhenRunning: true,
            showWhenAttentionRequired: true,
            showWhenReady: true,
            alwaysOnTop: true,
            autoHideEnabled: true,
            autoHideDelayMs: 6000,
            expandedBehavior: 'click',
            interactiveCollapsed: true,
            presentationMode: 'automatic',
            clickAction: 'expand_overlay',
            density: 'compact',
            compactStyle: 'pill',
            showSessionCount: true,
            showPreviewText: false,
            quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
            placementMode: 'custom',
            anchor: 'bottom_right',
            offsetX: 24,
            offsetY: -18,
            enableDragReposition: true,
            lockPosition: false,
        },
        window: {
            collapsed: { width: 340, height: 72 },
            expanded: { width: 420, height: 220 },
        },
        placementDiagnostics: {
            monitorSource: 'primary',
            effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
            anchor: 'bottom_right',
            placementMode: 'custom',
            requestedHostMode: hostMode,
            hostMode,
            displayContext: null,
            effectiveOffsetX: 24,
            effectiveOffsetY: -18,
            computedPosition: { x: 24, y: 24 },
        },
    };
}

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
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

describe('DesktopOverlaySettingsSection', () => {
    beforeEach(() => {
        applyLocalSettingsMock.mockReset();
        resetDesktopActivityOverlayPositionMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createDesktopOverlayWindowStatePayload('floating'));
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
            desktopOverlayPresentationMode: 'automatic',
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
        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(5);
        expect(screen.findRowByTitle('settingsDesktop.overlay.interactiveCollapsedTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.densityTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.compactStyleTitle')).toBeNull();
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
        expect(resetDesktopActivityOverlayPositionMock).toHaveBeenCalledTimes(1);

        const presentationModeMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.presentationModeTitle');
        expect(presentationModeMenu).toBeTruthy();
        presentationModeMenu?.props.onSelect?.('notch_integrated');
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayPresentationMode: 'notch_integrated',
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
        expect(screen.findRowByTitle('settingsDesktop.overlay.allowRepositioningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.lockPositionTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeNull();
    });

    it('hides attention filter rows outside attention-only mode', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenRunningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenAttentionRequiredTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenReadyTitle')).toBeNull();
    });

    it('also hides attention filter rows in always-visible mode', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'always_when_enabled',
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenRunningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenAttentionRequiredTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showWhenReadyTitle')).toBeNull();
    });

    it('does not render legacy experimental controls even when old settings still exist', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayInteractiveCollapsed: false,
            desktopOverlayClickAction: 'open_sessions',
            desktopOverlayExpandedBehavior: 'hover',
            desktopOverlayDensity: 'comfortable',
            desktopOverlayCompactStyle: 'panel',
            desktopOverlayShowSessionCount: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.interactiveCollapsedTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.collapsedClickActionTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.expandedBehaviorTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.densityTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.compactStyleTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.showSessionCountTitle')).toBeNull();
    });

    it('resets anchored placement back to anchored defaults', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_right',
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

    it('hides anchored preset controls while custom placement mode is active', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findAllByType('DropdownMenu' as any).some((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.anchorPresetTitle')).toBe(false);
        expect(screen.findRowByTitle('settingsDesktop.overlay.allowRepositioningTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsDesktop.overlay.lockPositionTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeTruthy();
    });

    it('hides floating-only placement controls while notch-integrated mode is selected', async () => {
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createDesktopOverlayWindowStatePayload('notch_integrated'));
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPresentationMode: 'notch_integrated',
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);

        expect(screen.findRowByTitle('settingsDesktop.overlay.placementModeTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.anchorPresetTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.allowRepositioningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.lockPositionTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeNull();
    });

    it('explains when the runtime falls back to a floating host mode on an unsupported display', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPresentationMode: 'automatic',
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            visible: true,
            expanded: false,
            model: {
                visible: true,
                isExpanded: false,
                generatedAt: Date.now(),
                collapsed: {
                    title: 'Session One',
                    statusText: 'Needs attention',
                    defaultTarget: 'open-primary-session',
                    sessionCount: 1,
                },
                expanded: {
                    title: 'Active sessions',
                    rows: [],
                },
                window: {
                    collapsed: { width: 340, height: 72 },
                    expanded: { width: 420, height: 220 },
                },
            },
            policy: {
                ...localSettingsDefaults,
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                presentationMode: 'automatic',
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                placementMode: 'custom',
                anchor: 'bottom_right',
                offsetX: 24,
                offsetY: -18,
                enableDragReposition: true,
                lockPosition: false,
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
            placementDiagnostics: {
                monitorSource: 'primary',
                effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                anchor: 'bottom_right',
                placementMode: 'custom',
                requestedHostMode: 'floating',
                hostMode: 'floating',
                displayContext: null,
                effectiveOffsetX: 24,
                effectiveOffsetY: -18,
                computedPosition: { x: 24, y: 24 },
            },
        });

        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findRowByTitle('settingsDesktop.overlay.hostModeFallbackTitle')).toBeTruthy();
    });

    it('uses the resolved host mode from the overlay runtime to hide floating placement controls even when presentation mode is floating overlay', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPresentationMode: 'floating_overlay',
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            visible: true,
            expanded: false,
            model: {
                visible: true,
                isExpanded: false,
                generatedAt: Date.now(),
                collapsed: {
                    title: 'Session One',
                    statusText: 'Needs attention',
                    defaultTarget: 'open-primary-session',
                    sessionCount: 1,
                },
                expanded: {
                    title: 'Active sessions',
                    rows: [],
                },
                window: {
                    collapsed: { width: 340, height: 72 },
                    expanded: { width: 420, height: 220 },
                },
            },
            policy: {
                ...localSettingsDefaults,
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                presentationMode: 'floating_overlay',
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                placementMode: 'custom',
                anchor: 'bottom_right',
                offsetX: 24,
                offsetY: -18,
                enableDragReposition: true,
                lockPosition: false,
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
            placementDiagnostics: {
                monitorSource: 'primary',
                effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                anchor: 'bottom_right',
                placementMode: 'custom',
                requestedHostMode: 'floating',
                hostMode: 'notch_integrated',
                displayContext: null,
                effectiveOffsetX: 24,
                effectiveOffsetY: -18,
                computedPosition: { x: 24, y: 24 },
            },
        });

        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findRowByTitle('settingsDesktop.overlay.placementModeTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.anchorPresetTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.allowRepositioningTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.lockPositionTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeNull();
    });

    it('updates the fallback notice and placement controls when the runtime host mode changes', async () => {
        let overlayStateListener: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | null = null;
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(async (handler) => {
            overlayStateListener = handler;
            return () => {
                overlayStateListener = null;
            };
        });
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPresentationMode: 'automatic',
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            visible: true,
            expanded: false,
            model: {
                visible: true,
                isExpanded: false,
                generatedAt: Date.now(),
                collapsed: {
                    title: 'Session One',
                    statusText: 'Needs attention',
                    defaultTarget: 'open-primary-session',
                    sessionCount: 1,
                },
                expanded: {
                    title: 'Active sessions',
                    rows: [],
                },
                window: {
                    collapsed: { width: 340, height: 72 },
                    expanded: { width: 420, height: 220 },
                },
            },
            policy: {
                ...localSettingsDefaults,
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                presentationMode: 'automatic',
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                placementMode: 'custom',
                anchor: 'bottom_right',
                offsetX: 24,
                offsetY: -18,
                enableDragReposition: true,
                lockPosition: false,
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
            placementDiagnostics: {
                monitorSource: 'primary',
                effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                anchor: 'bottom_right',
                placementMode: 'custom',
                requestedHostMode: 'floating',
                hostMode: 'floating',
                displayContext: null,
                effectiveOffsetX: 24,
                effectiveOffsetY: -18,
                computedPosition: { x: 24, y: 24 },
            },
        });

        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findRowByTitle('settingsDesktop.overlay.hostModeFallbackTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsDesktop.overlay.placementModeTitle')).toBeTruthy();

        await act(async () => {
            overlayStateListener?.({
                visible: true,
                expanded: false,
                model: {
                    visible: true,
                    isExpanded: false,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'Session One',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                    },
                    expanded: {
                        title: 'Active sessions',
                        rows: [],
                    },
                    window: {
                        collapsed: { width: 340, height: 72 },
                        expanded: { width: 420, height: 220 },
                    },
                },
                policy: {
                    ...localSettingsDefaults,
                    enabled: true,
                    visibilityMode: 'attention_only',
                    showWhenRunning: true,
                    showWhenAttentionRequired: true,
                    showWhenReady: true,
                    alwaysOnTop: true,
                    autoHideEnabled: true,
                    autoHideDelayMs: 6000,
                    expandedBehavior: 'click',
                    interactiveCollapsed: true,
                    presentationMode: 'automatic',
                    clickAction: 'expand_overlay',
                    density: 'compact',
                    compactStyle: 'pill',
                    showSessionCount: true,
                    showPreviewText: false,
                    quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                    placementMode: 'custom',
                    anchor: 'bottom_right',
                    offsetX: 24,
                    offsetY: -18,
                    enableDragReposition: true,
                    lockPosition: false,
                },
                window: {
                    collapsed: { width: 340, height: 72 },
                    expanded: { width: 420, height: 220 },
                },
                placementDiagnostics: {
                    monitorSource: 'primary',
                    effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                    anchor: 'bottom_right',
                    placementMode: 'custom',
                    requestedHostMode: 'floating',
                    hostMode: 'notch_integrated',
                    displayContext: null,
                    effectiveOffsetX: 24,
                    effectiveOffsetY: -18,
                    computedPosition: { x: 24, y: 24 },
                },
            });
        });

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findRowByTitle('settingsDesktop.overlay.hostModeFallbackTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsDesktop.overlay.placementModeTitle')).toBeNull();
    });

    it('clears stale custom placement state when placement mode switches back to anchored', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -18,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        };
        const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        const dropdownMenus = screen.findAllByType('DropdownMenu' as any);

        const placementModeMenu = dropdownMenus.find((menu) => menu.props.itemTrigger?.title === 'settingsDesktop.overlay.placementModeTitle');
        expect(placementModeMenu).toBeTruthy();

        placementModeMenu?.props.onSelect?.('anchored');

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
        });
        expect(resetDesktopActivityOverlayPositionMock).toHaveBeenCalledTimes(1);
    });
});
