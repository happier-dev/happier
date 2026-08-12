import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const layoutState = vi.hoisted(() => ({
    dockLocation: 'bottom' as 'bottom' | 'details' | 'sidebar',
    deviceType: 'tablet' as 'phone' | 'tablet',
    platformOS: 'web' as 'web' | 'ios',
    windowWidthPx: 1400,
}));
const routerPushSpy = vi.hoisted(() => vi.fn());

installSessionActionsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900 }),
            Platform: Object.defineProperty({}, 'OS', {
                get: () => layoutState.platformOS,
                enumerable: true,
            }) as any,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                if (key === 'embeddedTerminalDockLocation') return layoutState.dockLocation;
                if (key === 'uiMultiPanePanelsEnabled') return true;
                return null;
            },
        });
    },
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-session',
}));

const openBottomSpy = vi.fn();
const closeBottomSpy = vi.fn();
const setBottomTabSpy = vi.fn();
const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const terminalFeatureScopeState = vi.hoisted(() => ({ enabledForServerId: 'server-session' as string | null }));

const pane = {
    scopeId: 'session:s1',
    scopeState: {
        right: { isOpen: false, activeTabId: null as string | null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: false, activeTabId: null as string | null, tabState: {} },
    },
    openRight: openRightSpy,
    closeRight: closeRightSpy,
    setRightTab: setRightTabSpy,
    setRightTabState: vi.fn(),
    openBottom: openBottomSpy,
    closeBottom: closeBottomSpy,
    setBottomTab: setBottomTabSpy,
    setBottomTabState: vi.fn(),
    openDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => pane,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (_featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) =>
        terminalFeatureScopeState.enabledForServerId == null
        || (scope?.scopeKind === 'spawn' && scope.serverId === terminalFeatureScopeState.enabledForServerId),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => layoutState.deviceType,
}));

describe('SessionHeaderTerminalButton', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        openBottomSpy.mockClear();
        closeBottomSpy.mockClear();
        setBottomTabSpy.mockClear();
        openRightSpy.mockClear();
        closeRightSpy.mockClear();
        setRightTabSpy.mockClear();
        pane.scopeState.bottom.isOpen = false;
        pane.scopeState.bottom.activeTabId = null;
        pane.scopeState.right.isOpen = false;
        pane.scopeState.right.activeTabId = null;
        terminalFeatureScopeState.enabledForServerId = 'server-session';
        routerPushSpy.mockClear();
        layoutState.dockLocation = 'bottom';
        layoutState.deviceType = 'tablet';
        layoutState.platformOS = 'web';
        layoutState.windowWidthPx = 1400;
    });

    it('switches an open attached terminal back to the workspace shell instead of closing the pane', async () => {
        const { setSessionTerminalMode, readSessionTerminalMode } = await import('../terminal/sessionTerminalMode');
        setSessionTerminalMode('s1', 'session_attach');
        pane.scopeState.bottom.isOpen = true;
        pane.scopeState.bottom.activeTabId = 'terminal';

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');
        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />);

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(readSessionTerminalMode('s1')).toBe('workspace_shell');
        expect(closeBottomSpy).not.toHaveBeenCalled();
        expect(openBottomSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
    });

    it('opens terminal in the bottom pane when docked to bottom', async () => {
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(openBottomSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setBottomTabSpy).toHaveBeenCalledWith('terminal');
        expect(closeBottomSpy).not.toHaveBeenCalled();
    });

    it('closes the bottom pane when terminal is already open there', async () => {
        pane.scopeState.bottom.isOpen = true;
        pane.scopeState.bottom.activeTabId = 'terminal';

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(closeBottomSpy).toHaveBeenCalledTimes(1);
        expect(openBottomSpy).not.toHaveBeenCalled();
    });

    /**
     * The sidebar IS the right pane, and `resolvePaneLayout` hides the right pane on every phone —
     * where this button is also the one header icon rendered OUTSIDE the fold guard, so it is always
     * visible. Pressing it used to call `openRight` into a pane that is never drawn: visible, always,
     * and dead. Same defect the agents glyph had, one button over.
     */
    it('opens the terminal screen instead of a hidden right pane on a phone layout', async () => {
        layoutState.dockLocation = 'sidebar';
        layoutState.deviceType = 'phone';
        layoutState.platformOS = 'ios';
        layoutState.windowWidthPx = 390;

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');
        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />);

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/terminal?serverId=server-session');
        expect(openRightSpy).not.toHaveBeenCalled();
    });

    it('still opens the sidebar terminal in the right pane where the layout has one', async () => {
        layoutState.dockLocation = 'sidebar';

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');
        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />);

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('suppresses the header terminal button testID when the session screen is hidden', async () => {
        const { SessionScreenTestIdsProvider } = await import('../shell/sessionScreenTestIds');
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(
            <SessionScreenTestIdsProvider enabled={false}>
                <SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" serverId="server-session" />
            </SessionScreenTestIdsProvider>,
        );

        expect(screen.findByTestId('session-header-terminal-button')).toBeNull();
    });

    it('uses the viewed session server scope for terminal visibility', async () => {
        terminalFeatureScopeState.enabledForServerId = 'server-session';
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');
        const ScreenScopedTerminalButton = SessionHeaderTerminalButton as any;

        const screen = await renderScreen(
            <ScreenScopedTerminalButton
                sessionId="s1"
                scopeId="session:s1"
                serverId="server-session"
            />,
        );

        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();
    });
});
