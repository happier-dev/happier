import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
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
    current: {} as Record<string, unknown>,
}));
const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(async () => null),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);

function createDesktopOverlayWindowStatePayload(hostMode: 'floating' | 'notch_integrated'): DesktopActivityOverlayWindowStatePayload {
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

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: (node: any, target: any) => {
            const React = require('react');
            return React.createElement('Portal', { target }, node);
        },
    }),
}));

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSettings: () => localSettingsState.current,
        });
    },
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
}));

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => autostartState,
}));

describe('DesktopAppSettingsScreen', () => {
    beforeEach(() => {
        autostartState.supported = true;
        autostartState.enabled = false;
        autostartState.loading = false;
        autostartState.error = null;
        localSettingsState.current = {};
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createDesktopOverlayWindowStatePayload('floating'));
    });

    it('renders the desktop app settings content with the autostart and overlay surfaces', async () => {
        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        const screen = await renderSettingsView(<DesktopAppSettingsScreen />);

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
    });

    it('hides the autostart section when it is not supported', async () => {
        autostartState.supported = false;
        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        const screen = await renderSettingsView(<DesktopAppSettingsScreen />);

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
    });

    it('renders the real dropdown-backed overlay controls when the desktop overlay is enabled', async () => {
        localSettingsState.current = {
            desktopOverlayEnabled: true,
        };

        const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
        await withPopoverWebGlobals(async () => {
            const screen = await renderSettingsView(<DesktopAppSettingsScreen />);

            expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
            expect(screen.findRow('settings-desktop-overlay-visibility-mode')).toBeTruthy();
            expect(screen.findRow('settings-desktop-overlay-placement-mode')).toBeTruthy();
            expect(screen.findRow('settings-desktop-overlay-compact-style')).toBeNull();
        });
    });
});
