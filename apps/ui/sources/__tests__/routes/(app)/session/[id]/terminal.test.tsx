import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
let mockSessionId = 'session-1';
let isFocused = true;
let canGoBack = true;
let terminalFeatureEnabled = true;
let terminalDockLocation = 'sidebar';
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';

const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());

let scopeState: any = {
    right: { isOpen: false, activeTabId: null, tabState: {} },
    details: null,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

vi.mock('react-native', async (importOriginal) => {
    const rn = await importOriginal<typeof import('react-native')>();
    return {
        ...rn,
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: mockSessionId }),
    useRouter: () => ({
        back: routerBackSpy,
        push: routerPushSpy,
        replace: routerReplaceSpy,
    }),
    useNavigation: () => ({ canGoBack: () => canGoBack }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: `session:${mockSessionId}`,
        scopeState,
        openRight: openRightSpy,
        closeRight: closeRightSpy,
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/panes/SessionRightPanel', () => ({
    SessionRightPanel: (props: any) => React.createElement('SessionRightPanel', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        ensureSessionVisibleSpy(sessionId);
        return true;
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => terminalFeatureEnabled,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => terminalDockLocation,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

let SessionTerminalRouteScreen: React.ComponentType<any>;

describe('/session/[id]/terminal', () => {
    beforeAll(async () => {
        SessionTerminalRouteScreen = (await import('@/app/(app)/session/[id]/terminal')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        isFocused = true;
        canGoBack = true;
        terminalFeatureEnabled = true;
        terminalDockLocation = 'sidebar';
        deviceType = 'desktop';
        scopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: null,
        };
        openRightSpy.mockClear();
        closeRightSpy.mockClear();
        setRightTabSpy.mockClear();
        routerBackSpy.mockClear();
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        vi.clearAllMocks();
    });

    async function renderScreen() {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionTerminalRouteScreen />);
            await Promise.resolve();
        });
        return tree!;
    }

    it('opens the right pane with the terminal tab selected', async () => {
        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
    });

    it('re-targets the pane to terminal when an existing non-terminal tab is already active', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            details: null,
        };

        await renderScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        await renderScreen();

        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    });

    it('closes by navigating back and closing the right-pane state', async () => {
        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('falls back to the parent session route when there is no back stack', async () => {
        canGoBack = false;

        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('does not open the terminal pane when the route is unavailable and is redirecting away', async () => {
        terminalFeatureEnabled = false;

        await renderScreen();

        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });



    it('pushes the details route again when the session id changes even if the details key is unchanged', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [
                    {
                        key: 'file:README.md',
                        kind: 'file',
                        resource: { path: 'README.md' },
                    },
                ],
            },
        };

        const tree = await renderScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-1', details: 'file', path: 'README.md' },
        });

        mockSessionId = 'session-2';

        await act(async () => {
            tree.update(<SessionTerminalRouteScreen />);
            await Promise.resolve();
        });

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-2', details: 'file', path: 'README.md' },
        });
    });

});
